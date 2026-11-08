// Settles logged outcomes whose match has finished, using data/history/matches.jsonl. Run `npm run collect` first so
// recent results are there. Writes data/settled.jsonl. Matches it cannot find (leagues the history does not cover, or
// a team spelled differently) stay open; add spellings to data/aliases.json as {"stake name": "football-data name"}.
import { readFile } from "node:fs/promises";
import { readJsonl, appendJsonl, file, latestById, findResult, outcomeWon, norm } from "../lib/history.js";

let aliases = {};
try { aliases = Object.fromEntries(Object.entries(JSON.parse(await readFile(file("aliases.json"), "utf8"))).map(([k, v]) => [norm(k), v])); } catch {}
const matches = await readJsonl("history/matches.jsonl");
const done = new Set((await readJsonl("settled.jsonl")).map((r) => r.id));
const outs = latestById(await readJsonl("predictions.jsonl")).filter((o) => !done.has(o.id) && Date.parse(o.start) < Date.now() - 3 * 3600 * 1000);
if (!matches.length) { console.log("No history yet. Run: npm run collect"); process.exit(0); }

const out = [];
const missing = new Map();
let unsettleable = 0;
for (const o of outs) {
  const res = findResult(o, matches, aliases);
  if (!res) { missing.set(`${o.home} v ${o.away}`, (missing.get(`${o.home} v ${o.away}`) || 0) + 1); continue; }
  const won = outcomeWon(o, res);
  if (won == null) { unsettleable++; continue; }
  out.push({ id: o.id, won, hg: res.hg, ag: res.ag, hc: res.hc, ac: res.ac, settledAt: new Date().toISOString() });
}
await appendJsonl("settled.jsonl", out);
console.log(`Settled ${out.length} outcomes. ${unsettleable} could not be settled (for example corners with no corner data). ${missing.size} fixtures had no matching result yet.`);
if (missing.size) console.log("Still open:", [...missing.keys()].slice(0, 15).join("; "));
