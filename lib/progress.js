"use client";
// Progress panel for a slip build. The server reports which stage it is in (see app/api/slips/route.js). The time left
// is an estimate: every stage starts from a default guess, scaled by how long that stage really took on earlier runs
// on this device (kept in localStorage), so the estimate gets closer the more you use it.

const KEY = "slip-lab-timing";
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Default seconds per stage, from the size of the job. p is the plan sent by the server.
export function guessSecs(id, p = {}) {
  switch (id) {
    case "odds": return 8;
    case "stats": return 3 + 0.4 * (p.n || 40);
    case "news": return 4 + (p.news || 10);
    case "ai": return 15 + 3 * (p.models || 1);
    case "slips": return 4 + (p.selector ? 8 : 1.5) * (p.targets || 1);
    default: return 10;
  }
}

export function stageText(id, p = {}) {
  switch (id) {
    case "odds": return "Reading Stake odds";
    case "stats": return `Collecting past stats for ${p.n || "the"} matches`;
    case "news": return "Searching team news";
    case "ai": return `Asking ${p.models || 1} ${(p.models || 1) > 1 ? "models" : "model"} for predictions`;
    case "slips": return p.selector ? "Building the best combinations and reviewing them" : "Building the best combinations";
    default: return id;
  }
}

export function loadFactors() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; }
}
// Called after a finished run with the real seconds per stage.
export function learn(durs, plan) {
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

export function fmtLeft(s) {
  if (s < 8) return "Almost done";
  const r = Math.round(s / 5) * 5;
  if (r < 60) return `About ${r} seconds left`;
  const m = Math.floor(r / 60), sec = r % 60;
  return `About ${m} min${sec ? ` ${sec} s` : ""} left`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Pure maths, so it can be tested: bar percentage, seconds left and whether this stage is running late.
export function estimate({ plan, stages, idx, stageStart, factors = {} }, now) {
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

export default function Progress({ prog, now, startedAt }) {
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
