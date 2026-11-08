// How good are the probabilities? Brier score and calibration per market family, for each source: the de-margined
// market, the stats model and the final blend. Lower Brier is better. If "final" is not better than "market" over a
// few hundred outcomes, the extra modelling is not adding anything yet.
import { readJsonl, latestById } from "../lib/history.js";

const settled = new Map((await readJsonl("settled.jsonl")).map((r) => [r.id, r.won]));
const rows = latestById(await readJsonl("predictions.jsonl")).filter((o) => settled.has(o.id)).map((o) => ({ ...o, y: settled.get(o.id) ? 1 : 0 }));
if (!rows.length) { console.log("Nothing settled yet. Run: npm run collect && npm run settle"); process.exit(0); }
const family = (o) => (o.kind === "result" ? (["1", "X", "2"].includes(o.rtype) ? "result 1X2" : "double chance") : o.kind === "totals" ? "goals over/under" : o.kind);
const brier = (xs) => xs.reduce((a, [p, y]) => a + (p - y) ** 2, 0) / xs.length;
const logloss = (xs) => -xs.reduce((a, [p, y]) => a + Math.log(Math.max(1e-6, y ? p : 1 - p)), 0) / xs.length;
const fmt = (v) => v.toFixed(4);

for (const fam of [...new Set(rows.map(family))].sort()) {
  const r = rows.filter((o) => family(o) === fam);
  console.log(`\n${fam}  (${r.length} outcomes${r.length < 100 ? ", too few to trust" : ""})`);
  for (const src of ["market", "stats", "prob"]) {
    const xs = r.filter((o) => o[src] != null).map((o) => [o[src], o.y]);
    if (xs.length) console.log(`  ${src === "prob" ? "final " : src.padEnd(6)} n=${String(xs.length).padEnd(5)} brier ${fmt(brier(xs))}  logloss ${fmt(logloss(xs))}`);
  }
  const bins = Array.from({ length: 10 }, () => []);
  r.forEach((o) => bins[Math.min(9, Math.floor(o.prob * 10))].push(o));
  console.log("  final chance band -> actual hit rate");
  bins.forEach((b, i) => { if (b.length >= 5) console.log(`   ${i * 10}-${i * 10 + 10}%  n=${String(b.length).padEnd(4)} predicted ${(100 * b.reduce((a, o) => a + o.prob, 0) / b.length).toFixed(0)}%  actual ${(100 * b.reduce((a, o) => a + o.y, 0) / b.length).toFixed(0)}%`); });
}
