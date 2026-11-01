"use client";
import { useState } from "react";

// Any OpenRouter model id works. Check the current list at openrouter.ai/models.
const PRESETS = ["anthropic/claude-sonnet-4.5", "google/gemini-2.5-pro", "openai/gpt-5", "deepseek/deepseek-chat"];

export default function Home() {
  const [book, setBook] = useState("sportybet");
  const [mk, setMk] = useState("all");
  const [model, setModel] = useState(PRESETS[0]);
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true); setErr(""); setData(null);
    try {
      const r = await fetch(`/api/slips?book=${book}&model=${encodeURIComponent(model)}&markets=${mk}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Request failed");
      setData(j);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <main>
      <h1>Slip Lab</h1>
      <div className="sub">Football accumulators for the next 47 hours, built to minimum target odds.</div>
      <div className="bar">
        <select value={book} onChange={(e) => setBook(e.target.value)} aria-label="Bookmaker">
          <option value="sportybet">SportyBet</option>
          <option value="stake">Stake</option>
        </select>
        <select value={mk} onChange={(e) => setMk(e.target.value)} aria-label="Markets">
          <option value="all">All markets</option>
          <option value="totals">Over/Under only</option>
          <option value="result">Result and double chance only</option>
        </select>
        <input list="models" value={model} onChange={(e) => setModel(e.target.value)} aria-label="OpenRouter model" />
        <datalist id="models">{PRESETS.map((m) => <option key={m} value={m} />)}</datalist>
        <button onClick={run} disabled={busy}>{busy ? "Working..." : "Build slips"}</button>
      </div>
      {err && <p className="err">{err}</p>}
      {data && <p className="mute">{data.matches} matches and {data.marketsSeen} markets analysed with {data.model}</p>}
      {data?.slips.map((s) => (
        <section className="card" key={s.target}>
          <div className="head">
            <span className="big">{s.target}+ odds</span>
            {s.legs.length > 0 && (
              <span className="stats">
                {s.odds.toFixed(1)} total, {(s.prob * 100).toFixed(2)}% to land, expected return {s.expected.toFixed(2)} per 1 staked
              </span>
            )}
          </div>
          {s.legs.length === 0 && <p className="mute">{s.note}</p>}
          {s.legs.map((l) => (
            <div className="leg" key={l.matchId}>
              <div>
                <b>{l.label}</b>
                <div className="mute">{l.match}, {l.league}</div>
                {l.reason && <div className="mute">{l.reason}</div>}
              </div>
              <div>
                <b>{l.odds.toFixed(2)}</b>
                <div className="mute">{(l.prob * 100).toFixed(0)}%</div>
              </div>
            </div>
          ))}
        </section>
      ))}
      <p className="note">
        Probabilities are estimates, not facts. An expected return below 1 means the slip loses money on average. Check the final prices in the bookmaker app before staking, and only stake what you can afford to lose.
      </p>
    </main>
  );
}
