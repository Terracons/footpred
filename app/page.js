"use client";
import { useEffect, useState } from "react";
// ---- Progress panel (time estimate while slips are built) ----
// Progress panel for a slip build. The server reports which stage it is in (see app/api/slips/route.js). The time left
// is an estimate: every stage starts from a default guess, scaled by how long that stage really took on earlier runs
// on this device (kept in localStorage), so the estimate gets closer the more you use it.

const KEY = "slip-lab-timing";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Default seconds per stage, from the size of the job. p is the plan sent by the server.
function guessSecs(id, p = {}) {
  switch (id) {
    case "odds": return 8;
    case "stats": return 3 + 0.4 * (p.n || 40);
    case "news": return 4 + (p.news || 10);
    case "ai": return 15 + 3 * (p.models || 1);
    case "slips": return 4 + (p.selector ? 8 : 1.5) * (p.targets || 1);
    default: return 10;
  }
}

function stageText(id, p = {}) {
  switch (id) {
    case "odds": return "Reading Stake odds";
    case "stats": return `Collecting past stats for ${p.n || "the"} matches`;
    case "news": return "Searching team news";
    case "ai": return `Asking ${p.models || 1} ${(p.models || 1) > 1 ? "models" : "model"} for predictions`;
    case "slips": return p.selector ? "Building the best combinations and reviewing them" : "Building the best combinations";
    default: return id;
  }
}

function loadFactors() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
// Called after a finished run with the real seconds per stage.
function learn(durs, plan) {
  try {
    const old = loadFactors();
    const next = { ...old };
    for (const [id, d] of Object.entries(durs)) {
      const f = clamp(d / guessSecs(id, plan), 0.2, 5);
      next[id] = old[id] ? 0.5 * old[id] + 0.5 * f : f;
    }
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
}

function fmtLeft(s) {
  if (s < 8) return "Almost done";
  const r = Math.round(s / 5) * 5;
  if (r < 60) return `About ${r} seconds left`;
  const m = Math.floor(r / 60), sec = r % 60;
  return `About ${m} min${sec ? ` ${sec} s` : ""} left`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Pure maths, so it can be tested: bar percentage, seconds left and whether this stage is running late.
function estimate({ plan, stages, idx, stageStart, factors = {} }, now) {
  const exp = stages.map((id) => Math.max(1, guessSecs(id, plan) * (factors[id] || 1)));
  const total = exp.reduce((a, b) => a + b, 0) || 1;
  const e = idx >= 0 ? Math.max(0, (now - stageStart) / 1000) : 0;
  const cur = idx >= 0 ? exp[idx] : 0;
  const done = exp.slice(0, Math.max(0, idx)).reduce((a, b) => a + b, 0);
  const pct = Math.min(99, Math.round((100 * (done + Math.min(e, cur * 0.95))) / total));
  const late = idx >= 0 && e > cur * 1.3;
  const left = Math.max(0, total - done - Math.min(e, cur));
  return { pct, left, late, exp, elapsedStage: e };
}

function Progress({ prog, now, startedAt }) {
  if (!prog || !prog.stages.length) {
    return <div className="blank"><h2>Building your slips</h2><p>Starting...</p></div>;
  }
  const { plan, stages, idx } = prog;
  const { pct, left, late } = estimate(prog, now);
  const total = Math.max(0, (now - startedAt) / 1000);
  const status = idx >= 0 ? stageText(stages[idx], plan) : "Starting";
  return (
    <div className="prog" aria-live="off">
      <h2>Building your slips</h2>
      <div className="prog-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Progress">
        <div className="prog-fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="prog-time">
        <strong>{late ? "Taking longer than usual, still working" : fmtLeft(left)}</strong>
        <span> · {clock(total)} elapsed · estimate</span>
      </p>
      <ol className="prog-steps">
        {stages.map((id, i) => (
          <li key={id} className={i < idx ? "done" : i === idx ? "now" : ""}>
            <span className="dot" aria-hidden="true">{i < idx ? "✓" : ""}</span>{stageText(id, plan)}
          </li>
        ))}
      </ol>
      <span className="sr" role="status">{status}</span>
    </div>
  );
}
// ---- end of progress panel ----

const PRESET_TARGETS = [5, 10, 20, 50, 100, 200];
// Any OpenRouter model id works. Check current names at openrouter.ai/models.
const PRESET_MODELS = ["minimax/minimax-m3.1-flash", "deepseek/deepseek-v4.1-flash-1017", "deepseek/deepseek-chat"];
const MARKETS = [
  ["result", "Result (1, X, 2)"], ["win", "1 or 2 only"], ["doublechance", "Double chance (1X, X2, 12)"],
  ["dc_no12", "1X or X2 only"], ["dc_12", "12 only"],
  ["totals", "Over/under"], ["over", "Over only"], ["under", "Under only"],
  ["btts", "Both teams to score"], ["corners", "Corners"], ["corners_over", "Corners over only"], ["corners_under", "Corners under only"],
];
const WINDOW_PRESETS = [6, 12, 24, 48, 72, 168];
const BASES = [["led", "Past stats lead"], ["balanced", "Balanced with market"]];
const STORE = "slip-lab:v3";

const kick = (iso) => new Date(iso).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });

function Seg({ value, options, onChange, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, t]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{t}</button>
      ))}
    </div>
  );
}

function Chip({ text, onRemove }) {
  return (
    <span className="chip">
      {text}
      <button type="button" aria-label={`Remove ${text}`} onClick={onRemove}>×</button>
    </span>
  );
}

function Ticket({ s, i }) {
  const [copied, setCopied] = useState(false);
  const delay = { animationDelay: `${i * 140}ms` };
  if (!s.legs.length) {
    return (
      <article className="ticket" style={delay}>
        <div className="stub"><span className="target">{s.target}+ odds</span></div>
        <p className="note">{s.note}</p>
      </article>
    );
  }
  const text = `${s.target}+ odds slip\n` + s.legs.map((l) => `${l.label} (${l.match}) @ ${l.odds.toFixed(2)}`).join("\n") + `\nTotal odds ${s.odds.toFixed(2)}`;
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  }
  return (
    <article className="ticket" style={delay}>
      <div className="stub">
        <div>
          <span className="target">{s.target}+ odds</span>
          <span className="total">{s.odds.toFixed(2)}</span>
        </div>
        <dl className="facts">
          <div><dt>Chance to land</dt><dd>{(s.prob * 100).toFixed(2)}%</dd></div>
          <div><dt>Expected return per 1</dt><dd className={s.expected < 1 ? "bad" : ""}>{s.expected.toFixed(2)}</dd></div>
          <div><dt>Legs</dt><dd>{s.legs.length}</dd></div>
        </dl>
      </div>
      <div className="perf" />
      <ul className="legs">
        {s.legs.map((l) => (
          <li key={l.matchId}>
            <div className="who">
              <b>{l.label}</b>
              <span>{l.match}</span>
              <span>{l.league}, {kick(l.start)}</span>
              {l.why && <span className="why">{l.why}</span>}
              {l.reason && <em>{l.reason}</em>}
            </div>
            <div className="num">
              <b>{l.odds.toFixed(2)}</b>
              <i style={{ "--w": `${Math.round(l.prob * 100)}%` }} aria-hidden="true" />
              <span>{Math.round(l.prob * 100)}% likely</span>
            </div>
          </li>
        ))}
      </ul>
      {s.note && <p className="note">{s.note}</p>}
      {s.warning && <p className="note">{s.warning}</p>}
      {s.notes && <p className="note">Selector: {s.notes}</p>}
      <div className="foot">
        <button type="button" className="ghost" onClick={copy}>{copied ? "Copied" : "Copy slip"}</button>
      </div>
    </article>
  );
}

export default function Home() {
  const [targets, setTargets] = useState([10, 50, 100]);
  const [models, setModels] = useState([PRESET_MODELS[0]]);
  const [mode, setMode] = useState("blend");
  const [markets, setMarkets] = useState(["all"]);
  const [hours, setHours] = useState("47");
  const [fromHours, setFromHours] = useState("0");
  const [leagues, setLeagues] = useState("");
  const [unique, setUnique] = useState(true);
  const [requireStats, setRequireStats] = useState(true);
  const [allowDraw, setAllowDraw] = useState(false);
  const [prefer1X, setPrefer1X] = useState(true);
  const [basis, setBasis] = useState("led");
  const [minLegs, setMinLegs] = useState("");
  const [maxLegs, setMaxLegs] = useState("");
  const [minLegOdds, setMinLegOdds] = useState("1.08");
  const [maxLegOdds, setMaxLegOdds] = useState("2.2");
  const [tolerance, setTolerance] = useState("8");
  const [matchLimit, setMatchLimit] = useState("60");
  const [customT, setCustomT] = useState("");
  const [customM, setCustomM] = useState("");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState(null);
  const [now, setNow] = useState(0);
  const [startedAt, setStartedAt] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || "null");
      if (v) {
        if (v.targets?.length) setTargets(v.targets);
        if (v.models?.length) setModels(v.models);
        if (v.mode) setMode(v.mode);
        if (v.markets) setMarkets(Array.isArray(v.markets) ? v.markets : [v.markets]);
        const str = (x, set) => { if (x !== undefined && x !== null) set(String(x)); };
        str(v.hours, setHours); str(v.fromHours, setFromHours); str(v.leagues, setLeagues);
        str(v.minLegs, setMinLegs); str(v.maxLegs, setMaxLegs); str(v.minLegOdds, setMinLegOdds);
        str(v.maxLegOdds, setMaxLegOdds); str(v.tolerance, setTolerance); str(v.matchLimit, setMatchLimit);
        if (v.basis) setBasis(v.basis);
        if (typeof v.unique === "boolean") setUnique(v.unique);
        if (typeof v.requireStats === "boolean") setRequireStats(v.requireStats);
        if (typeof v.allowDraw === "boolean") setAllowDraw(v.allowDraw);
        if (typeof v.prefer1X === "boolean") setPrefer1X(v.prefer1X);
      }
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(STORE, JSON.stringify({ targets, models, mode, markets, hours, fromHours, leagues, unique, requireStats, allowDraw, prefer1X, basis, minLegs, maxLegs, minLegOdds, maxLegOdds, tolerance, matchLimit }));
    } catch {}
  }, [ready, targets, models, mode, markets, hours, fromHours, leagues, unique, requireStats, allowDraw, prefer1X, basis, minLegs, maxLegs, minLegOdds, maxLegOdds, tolerance, matchLimit]);

  function addTarget(n) {
    n = Number(n);
    if (n >= 2 && n <= 1000 && !targets.includes(n) && targets.length < 5) setTargets([...targets, n].sort((a, b) => a - b));
    setCustomT("");
  }
  function addModel(m) {
    m = m.trim();
    if (m && !models.includes(m) && models.length < 4) setModels([...models, m]);
    setCustomM("");
  }

  // Keeps the clock in the progress panel moving while a build runs.
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [busy]);

  async function run() {
    const t0 = Date.now();
    setBusy(true); setErr(""); setData(null); setNow(t0); setStartedAt(t0);
    const factors = loadFactors();
    let plan = null, stages = [], idx = -1, stageStart = t0, result = null;
    const durs = {};
    const push = () => setProg({ plan, stages, idx, stageStart, factors });
    setProg({ plan: null, stages: [], idx: -1, stageStart: t0, factors });
    try {
      const r = await fetch("/api/slips", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets, models, mode, markets, hours, fromHours, leagues, unique, requireStats, allowDraw, prefer1X, basis, minLegs, maxLegs, minLegOdds, maxLegOdds, tolerance, matchLimit }),
      });
      // A rejected request (bad input) is plain JSON. An accepted one streams one JSON object per line.
      if (!(r.headers.get("content-type") || "").includes("ndjson")) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error || "Request failed");
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const handle = (ev) => {
        if (ev.type === "plan") { plan = ev; stages = ev.stages; push(); }
        else if (ev.type === "stage") {
          const t = Date.now();
          if (idx >= 0) durs[stages[idx]] = (t - stageStart) / 1000;
          idx = stages.indexOf(ev.id); stageStart = t;
          if (ev.n) plan = { ...plan, n: ev.n };
          push();
        } else if (ev.type === "result") result = ev.data;
        else if (ev.type === "error") throw new Error(ev.error || "Request failed");
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) handle(JSON.parse(line));
        }
      }
      if (!result) throw new Error("The connection closed before the slips were ready. Try again.");
      if (idx >= 0) durs[stages[idx]] = (Date.now() - stageStart) / 1000;
      learn(durs, plan);
      setData(result); setTab(0);
    } catch (e) { setErr(e.message); }
    setBusy(false); setProg(null);
  }

  const set = data?.sets[tab];
  return (
    <main className="shell">
      <header className="top">
        <h1>Slip Lab</h1>
        <p>Football accumulators for Stake, built to the odds you choose.</p>
      </header>
      <div className="grid">
        <aside className="panel">
          <section>
            <h2>Target odds</h2>
            <p className="help">Each slip aims to reach at least this total. Up to 5.</p>
            <div className="chips">{targets.map((t) => <Chip key={t} text={`${t}+`} onRemove={() => setTargets(targets.filter((x) => x !== t))} />)}</div>
            <div className="quick">
              {PRESET_TARGETS.filter((t) => !targets.includes(t)).map((t) => <button key={t} type="button" onClick={() => addTarget(t)}>{t}</button>)}
            </div>
            <div className="add">
              <input type="number" min="2" max="1000" inputMode="numeric" placeholder="Custom, such as 30" value={customT}
                onChange={(e) => setCustomT(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTarget(customT)} aria-label="Custom target odds" />
              <button type="button" onClick={() => addTarget(customT)}>Add</button>
            </div>
          </section>
          <section>
            <h2>Models</h2>
            <p className="help">Pick up to 4 from OpenRouter.</p>
            <div className="chips">{models.map((m) => <Chip key={m} text={m} onRemove={() => models.length > 1 && setModels(models.filter((x) => x !== m))} />)}</div>
            <div className="quick">
              {PRESET_MODELS.filter((m) => !models.includes(m)).map((m) => <button key={m} type="button" onClick={() => addModel(m)}>{m}</button>)}
            </div>
            <div className="add">
              <input value={customM} placeholder="Any OpenRouter model id" onChange={(e) => setCustomM(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addModel(customM)} aria-label="Custom model id" />
              <button type="button" onClick={() => addModel(customM)}>Add</button>
            </div>
            {models.length > 1 && (
              <Seg label="How to use several models" value={mode} onChange={setMode}
                options={[["blend", "Blend into one"], ["compare", "Compare side by side"]]} />
            )}
          </section>
          <section>
            <h2>Markets</h2>
            <p className="help">Pick any mix. Only these outcomes can become legs.</p>
            <div className="seg wrap" role="group" aria-label="Markets">
              <button type="button" aria-pressed={markets.includes("all")} onClick={() => setMarkets(["all"])}>All markets</button>
              {MARKETS.map(([v, t]) => (
                <button key={v} type="button" aria-pressed={markets.includes(v)}
                  onClick={() => setMarkets((cur) => {
                    const base = cur.filter((x) => x !== "all");
                    const next = base.includes(v) ? base.filter((x) => x !== v) : [...base, v];
                    return next.length ? next : ["all"];
                  })}>{t}</button>
              ))}
            </div>
          </section>
          <section>
            <h2>Kick off window</h2>
            <p className="help">Any length from 1 to 168 hours. Starts now, or later if you set a start.</p>
            <div className="quick">
              {WINDOW_PRESETS.map((h) => <button key={h} type="button" onClick={() => setHours(String(h))}>{h}h</button>)}
            </div>
            <div className="fields">
              <label>Hours to cover<input type="number" min="1" max="168" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} /></label>
              <label>Starts in (hours)<input type="number" min="0" max="96" inputMode="numeric" value={fromHours} onChange={(e) => setFromHours(e.target.value)} /></label>
            </div>
          </section>
          <section>
            <h2>Leagues</h2>
            <p className="help">Optional. Words from league or team names, separated by commas. Start a word with a minus to leave it out.</p>
            <div className="add">
              <input value={leagues} placeholder="premier, la liga, -women, -u21" onChange={(e) => setLeagues(e.target.value)} aria-label="League filter" />
            </div>
          </section>
          <section>
            <h2>Picks</h2>
            <label className="check">
              <input type="checkbox" checked={requireStats} onChange={(e) => setRequireStats(e.target.checked)} />
              Only matches with past data (table, form, goals)
            </label>
            <label className="check">
              <input type="checkbox" checked={prefer1X} onChange={(e) => setPrefer1X(e.target.checked)} />
              Lean toward 1X (home win or draw)
            </label>
            <label className="check">
              <input type="checkbox" checked={allowDraw} onChange={(e) => setAllowDraw(e.target.checked)} />
              Allow draw picks
            </label>
            <label className="check">
              <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
              Use each match once across slips
            </label>
          </section>
          <details className="adv">
            <summary>More settings</summary>
            <div className="advbody">
              <div>
                <h2>Weight on past stats</h2>
                <Seg label="Weight on past stats" value={basis} onChange={setBasis} options={BASES} />
              </div>
              <div className="fields">
                <label>Fewest legs<input type="number" min="1" max="40" placeholder="auto" value={minLegs} onChange={(e) => setMinLegs(e.target.value)} /></label>
                <label>Most legs<input type="number" min="1" max="40" placeholder="auto (30)" value={maxLegs} onChange={(e) => setMaxLegs(e.target.value)} /></label>
                <label>Lowest odds per leg<input type="number" step="0.01" min="1.01" value={minLegOdds} onChange={(e) => setMinLegOdds(e.target.value)} /></label>
                <label>Highest odds per leg<input type="number" step="0.1" min="1.1" placeholder="no cap" value={maxLegOdds} onChange={(e) => setMaxLegOdds(e.target.value)} /></label>
                <label>Land within % above target<input type="number" min="0" max="50" value={tolerance} onChange={(e) => setTolerance(e.target.value)} /></label>
                <label>Most matches to study<input type="number" min="10" max="100" value={matchLimit} onChange={(e) => setMatchLimit(e.target.value)} /></label>
              </div>
            </div>
          </details>
          <div className="cta">
            <button type="button" className="go" onClick={run} disabled={busy || !targets.length}>{busy ? "Building..." : "Build slips"}</button>
          </div>
        </aside>

        <section className="out" aria-live="polite">
          {busy && <Progress prog={prog} now={now} startedAt={startedAt} />}
          {err && !busy && <div className="blank bad"><h2>Could not build slips</h2><p>{err}</p></div>}
          {!data && !busy && !err && <div className="blank"><h2>No slips yet</h2><p>Choose your target odds, models and time window, then build. Each slip appears here as a ticket.</p></div>}
          {data && !busy && (
            <>
              <p className="meta">{data.matches} Stake matches and {data.marketsSeen} markets read. Past data found for {data.enriched}, {data.shortlisted} matches used for slips.</p>
              {data.warnings.map((w) => <p className="warn" key={w}>{w}</p>)}
              {data.sets.length > 1 ? (
                <div className="tabs" role="tablist">
                  {data.sets.map((s, k) => <button key={s.model} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{s.model}</button>)}
                </div>
              ) : <p className="meta">Model: {data.sets[0].model}</p>}
              {set?.slips.map((s, i) => <Ticket key={`${tab}-${s.target}`} s={s} i={i} />)}
              <p className="fine">
                Probabilities are estimates, not facts. An expected return below 1 means the slip loses money on average. Check final prices on Stake before staking, and only stake what you can afford to lose.
              </p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}