// Historical match data and result settling. Pure functions plus small file helpers, no network calls.
// Source: football-data.co.uk. Main leagues (one file per season) carry corners, shots, cards and closing odds.
// "Extra" leagues (Argentina, Brazil, ...) carry results and odds only. A value that is missing stays null, never 0.
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");
export const file = (name) => path.join(DATA_DIR, name);

export async function readJsonl(name) {
  try {
    const text = await readFile(file(name), "utf8");
    return text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}
export async function writeJsonl(name, rows) {
  await mkdir(path.dirname(file(name)), { recursive: true });
  await writeFile(file(name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}
export async function appendJsonl(name, rows) {
  if (!rows.length) return;
  await mkdir(path.dirname(file(name)), { recursive: true });
  await appendFile(file(name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

// ---- CSV ----
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some((x) => x !== "")) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); if (row.some((x) => x !== "")) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const num = (v) => (v === undefined || v === null || String(v).trim() === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const firstNum = (r, cols) => { for (const c of cols) { const v = num(r[c]); if (v != null) return v; } return null; };
export function isoDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(String(s).trim());
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${y}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;
}

// Main-league file (mmz4281/<season>/<div>.csv): full stats.
export function parseMain(text, { div, season }) {
  return parseCsv(text).map((r) => {
    const date = isoDate(r.Date);
    const hg = num(r.FTHG), ag = num(r.FTAG);
    if (!date || !r.HomeTeam || !r.AwayTeam || hg == null || ag == null) return null; // unfinished or blank rows
    return {
      src: "fd", div, season, date, time: r.Time || null, home: r.HomeTeam, away: r.AwayTeam, hg, ag,
      hthg: num(r.HTHG), htag: num(r.HTAG), hs: num(r.HS), as: num(r.AS), hst: num(r.HST), ast: num(r.AST),
      hf: num(r.HF), af: num(r.AF), hc: num(r.HC), ac: num(r.AC), hy: num(r.HY), ay: num(r.AY), hr: num(r.HR), ar: num(r.AR),
      odds: {
        h: firstNum(r, ["AvgCH", "AvgH", "B365CH", "B365H"]), d: firstNum(r, ["AvgCD", "AvgD", "B365CD", "B365D"]), a: firstNum(r, ["AvgCA", "AvgA", "B365CA", "B365A"]),
        o25: firstNum(r, ["AvgC>2.5", "Avg>2.5", "B365C>2.5", "B365>2.5"]), u25: firstNum(r, ["AvgC<2.5", "Avg<2.5", "B365C<2.5", "B365<2.5"]),
      },
    };
  }).filter(Boolean);
}

// "Extra leagues" file (new/<code>.csv): all seasons in one file, results and odds only.
export function parseExtra(text, { div, since }) {
  return parseCsv(text).map((r) => {
    const date = isoDate(r.Date);
    const hg = num(r.HG), ag = num(r.AG);
    if (!date || !r.Home || !r.Away || hg == null || ag == null || (since && date < since)) return null;
    return {
      src: "fd", div, season: r.Season || null, date, time: r.Time || null, home: r.Home, away: r.Away, hg, ag,
      hthg: null, htag: null, hs: null, as: null, hst: null, ast: null, hf: null, af: null, hc: null, ac: null, hy: null, ay: null, hr: null, ar: null,
      odds: { h: firstNum(r, ["AvgH", "PH"]), d: firstNum(r, ["AvgD", "PD"]), a: firstNum(r, ["AvgA", "PA"]), o25: null, u25: null },
    };
  }).filter(Boolean);
}

// ---- Team names: Stake and football-data spell clubs differently ("Man United" / "Manchester United") ----
const STOP = new Set(["fc", "afc", "cf", "sc", "ac", "as", "fk", "sk", "if", "bk", "cd", "ca", "ssc", "club", "calcio", "football", "foot", "the", "de", "del", "la", "le"]);
// Words shared by many clubs. They never match on their own ("Leeds United" must not match "Manchester United").
const GENERIC = new Set(["united", "city", "town", "county", "athletic", "albion", "rovers", "wanderers", "rangers", "real", "sporting", "dynamo", "hotspur", "borough", "olympic"]);
const strip = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
// Common abbreviations in football-data: Man United, Man City, Nott'm Forest, Sheffield Weds, Wolves, Spurs.
const expand = (s) => strip(s).replace(/\bman\b/g, "manchester").replace(/\butd\b/g, "united").replace(/nott'?m\b/g, "nottingham")
  .replace(/\bweds\b/g, "wednesday").replace(/\bwolves\b/g, "wolverhampton wanderers").replace(/\bspurs\b/g, "tottenham hotspur");
export const norm = (s) => strip(s).replace(/[^a-z0-9]/g, "");
const tokens = (s) => {
  const all = expand(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOP.has(t));
  const own = all.filter((t) => !GENERIC.has(t));
  return own.length ? own : all;
};
// 2 = same name, 1 = a distinctive word in common, 0 = different club
export function teamScore(a, b, aliases = {}) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 2;
  const al = aliases[na];
  if (al && norm(al) === nb) return 2;
  if (na.length >= 5 && nb.length >= 5 && (na.includes(nb) || nb.includes(na))) return 1;
  const ta = tokens(a), tb = tokens(b);
  return ta.some((t) => t.length >= 4 && tb.includes(t)) ? 1 : 0;
}
export const sameTeam = (a, b, aliases = {}) => teamScore(a, b, aliases) > 0;

const dayDiff = (a, b) => Math.abs(Date.parse(a.slice(0, 10)) - Date.parse(b.slice(0, 10))) / 86400000;
// Finds the finished match for a logged fixture: both teams must match and the date must be within a day.
// When several candidates fit, the closest spelling and the closest date win.
export function findResult(rec, matches, aliases = {}) {
  let best = null, bestScore = 0;
  for (const r of matches) {
    const d = dayDiff(rec.start, r.date);
    if (d > 1) continue;
    const h = teamScore(rec.home, r.home, aliases), a = teamScore(rec.away, r.away, aliases);
    if (!h || !a) continue;
    const score = h + a - d * 0.1;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  return best;
}

// true, false, or null when the outcome cannot be settled from this result (for example corners with no corner data).
export function outcomeWon(rec, res) {
  const { hg, ag } = res;
  if (hg == null || ag == null) return null;
  if (rec.kind === "result") {
    const t = rec.rtype;
    if (t === "1") return hg > ag;
    if (t === "X") return hg === ag;
    if (t === "2") return ag > hg;
    if (t === "1X") return hg >= ag;
    if (t === "X2") return ag >= hg;
    if (t === "12") return hg !== ag;
    return null;
  }
  const line = Number(rec.handicap);
  const over = /over/i.test(rec.outcome), under = /under/i.test(rec.outcome);
  if (rec.kind === "totals" && Number.isFinite(line)) return over ? hg + ag > line : under ? hg + ag < line : null;
  if (rec.kind === "btts") return /yes/i.test(rec.outcome) ? hg > 0 && ag > 0 : /no/i.test(rec.outcome) ? !(hg > 0 && ag > 0) : null;
  if (rec.kind === "corners" && Number.isFinite(line)) {
    if (res.hc == null || res.ac == null) return null;
    const c = res.hc + res.ac;
    return over ? c > line : under ? c < line : null;
  }
  return null;
}

// The latest logged record per outcome id (a fixture analysed twice keeps its most recent, pre-kickoff analysis).
export function latestById(rows) {
  const m = new Map();
  for (const r of rows) if (r.t === "outcome") m.set(r.id, r);
  return [...m.values()];
}

export function currentSeasonCode(now = new Date()) {
  const y = now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return `${String(y % 100).padStart(2, "0")}${String((y + 1) % 100).padStart(2, "0")}`;
}
export function seasonCodes(n, now = new Date()) {
  const cur = Number(currentSeasonCode(now).slice(0, 2));
  return Array.from({ length: n }, (_, i) => `${String(cur - i).padStart(2, "0")}${String(cur - i + 1).padStart(2, "0")}`);
}