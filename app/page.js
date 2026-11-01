"use client";
import { useEffect, useState } from "react";

const PRESET_TARGETS = [5, 10, 20, 50, 100, 200];
// Any OpenRouter model id works. Check current names at openrouter.ai/models.
const PRESET_MODELS = ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "openai/gpt-5", "deepseek/deepseek-chat"];
const MARKETS = [["all", "All markets"], ["totals", "Over/under"], ["result", "Result"]];
const WINDOWS = [[12, "12 hours"], [24, "24 hours"], [47, "47 hours"]];
const STORE = "slip-lab:v2";

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
          <span className="total">{s.odds.toFixed(1)}</span>
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
  const [markets, setMarkets] = useState("all");
  const [hours, setHours] = useState(47);
  const [unique, setUnique] = useState(true);
  const [customT, setCustomT] = useState("");
  const [customM, setCustomM] = useState("");
  const [data, setData] = useState(null);
  const [tab, setTab] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(STORE) || "null");
      if (v) {
        if (v.targets?.length) setTargets(v.targets);
        if (v.models?.length) setModels(v.models);
        if (v.mode) setMode(v.mode);
        if (v.markets) setMarkets(v.markets);
        if (v.hours) setHours(v.hours);
        if (typeof v.unique === "boolean") setUnique(v.unique);
      }
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(STORE, JSON.stringify({ targets, models, mode, markets, hours, unique })); } catch {}
  }, [ready, targets, models, mode, markets, hours, unique]);

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

  async function run() {
    setBusy(true); setErr(""); setData(null);
    try {
      const r = await fetch("/api/slips", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targets, models, mode, markets, hours, unique }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Request failed");
      setData(j); setTab(0);
    } catch (e) { setErr(e.message); }
    setBusy(false);
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
            <Seg label="Markets" value={markets} onChange={setMarkets} options={MARKETS} />
          </section>
          <section>
            <h2>Kick off within</h2>
            <Seg label="Time window" value={hours} onChange={setHours} options={WINDOWS} />
          </section>
          <label className="check">
            <input type="checkbox" checked={unique} onChange={(e) => setUnique(e.target.checked)} />
            Use each match once across slips
          </label>
          <div className="cta">
            <button type="button" className="go" onClick={run} disabled={busy || !targets.length}>{busy ? "Building..." : "Build slips"}</button>
          </div>
        </aside>

        <section className="out" aria-live="polite">
          {busy && <div className="blank"><h2>Building your slips</h2><p>Reading Stake odds and asking {models.length} {models.length > 1 ? "models" : "model"}. This can take up to a minute.</p></div>}
          {err && !busy && <div className="blank bad"><h2>Could not build slips</h2><p>{err}</p></div>}
          {!data && !busy && !err && <div className="blank"><h2>No slips yet</h2><p>Choose your target odds and models, then build. Each slip appears here as a ticket.</p></div>}
          {data && !busy && (
            <>
              <p className="meta">{data.matches} Stake matches and {data.marketsSeen} markets read.</p>
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
