// Downloads historical results from football-data.co.uk into data/history/matches.jsonl (safe to re-run: it merges).
// Usage: npm run collect                       main leagues, last 3 seasons, plus the extra leagues
//        npm run collect -- --seasons 4       last 4 seasons
//        npm run collect -- --leagues E0,D1   only these league files (extra leagues are skipped)
//        npm run collect -- --no-extra        main leagues only
import { parseMain, parseExtra, readJsonl, writeJsonl, seasonCodes, norm } from "../lib/history.js";

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const MAIN = ["E0", "E1", "E2", "E3", "EC", "SC0", "SC1", "SC2", "SC3", "D1", "D2", "I1", "I2", "SP1", "SP2", "F1", "F2", "N1", "B1", "P1", "T1", "G1"];
const EXTRA = ["ARG", "AUT", "BRA", "CHN", "DNK", "FIN", "IRL", "JPN", "MEX", "NOR", "POL", "ROU", "RUS", "SWE", "SWZ", "USA"];
const seasons = seasonCodes(Number(arg("seasons")) || 3);
const only = arg("leagues")?.split(",").map((s) => s.trim()).filter(Boolean);
const main = only || MAIN;
const extra = only || process.argv.includes("--no-extra") ? [] : EXTRA;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const since = `${2000 + Number(seasons[seasons.length - 1].slice(0, 2))}-07-01`;

async function fetchText(url) {
  const res = await fetch(url, { headers: { "User-Agent": "slip-lab history collector" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const key = (r) => `${r.div}|${r.date}|${norm(r.home)}|${norm(r.away)}`;
const store = new Map((await readJsonl("history/matches.jsonl")).map((r) => [key(r), r]));
const before = store.size;
let files = 0, failed = [];

for (const season of seasons) {
  for (const div of main) {
    try {
      const rows = parseMain(await fetchText(`https://www.football-data.co.uk/mmz4281/${season}/${div}.csv`), { div, season });
      rows.forEach((r) => store.set(key(r), r));
      files++;
      process.stdout.write(`${div} ${season}: ${rows.length} matches\n`);
    } catch (e) { failed.push(`${div} ${season} (${e.message})`); }
    await sleep(250);
  }
}
for (const div of extra) {
  try {
    const rows = parseExtra(await fetchText(`https://www.football-data.co.uk/new/${div}.csv`), { div, since });
    rows.forEach((r) => store.set(key(r), r));
    files++;
    process.stdout.write(`${div}: ${rows.length} matches since ${since}\n`);
  } catch (e) { failed.push(`${div} (${e.message})`); }
  await sleep(250);
}

const all = [...store.values()].sort((a, b) => a.date.localeCompare(b.date));
await writeJsonl("history/matches.jsonl", all);
const withCorners = all.filter((r) => r.hc != null && r.ac != null).length;
console.log(`\n${files} files read, ${all.length} matches stored (${all.length - before} new). Corner data on ${withCorners} (${Math.round((100 * withCorners) / Math.max(1, all.length))}%).`);
if (failed.length) console.log(`Not available (normal for seasons or leagues the site does not publish): ${failed.join("; ")}`);
