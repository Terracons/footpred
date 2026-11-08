// Writes every analysis to data/predictions.jsonl before kickoff, so the model can later be judged on results.
//  - "outcome": every outcome of every market for each analysed match, with market, stats, AI and final chances
//  - "slip":    the slips that were shown, as lists of outcome ids
// Never throws: on read-only hosting (for example Vercel) it just reports that nothing was written.
import { appendJsonl } from "./history.js";
import { merge, applyNews, snapshot } from "./slips.js";

export const MODEL_VERSION = "slip-lab-v2";

export async function recordRun({ list, predsList, sets, meta = {} }) {
  try {
    const ts = new Date().toISOString();
    const runId = `${ts}-${Math.random().toString(36).slice(2, 6)}`;
    const preds = merge(predsList);
    applyNews(list, preds);
    const rows = [{ t: "run", runId, ts, model: MODEL_VERSION, ...meta }];
    for (const m of list) {
      if (new Date(m.start) <= new Date()) continue; // only pre-match analyses are valid evidence
      for (const o of snapshot(m, preds[m.id] || {}, meta.opts)) rows.push({ t: "outcome", runId, ts, ...o });
    }
    for (const set of sets || []) {
      for (const s of set.slips || []) {
        if (!s.legs?.length) continue;
        rows.push({ t: "slip", runId, ts, set: set.model, target: s.target, odds: s.odds, prob: s.prob, source: s.source || null, legs: s.legs.map((l) => l.key).filter(Boolean) });
      }
    }
    await appendJsonl("predictions.jsonl", rows);
    return { written: rows.length };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}