import { enrichAll } from "./enrich.js";
import { predict } from "./ai.js";
import { statsMarkdown, slipMarkdown, sentimentMarkdown } from "./report.js";
import { select } from "./select.js";
import { researchNews } from "./news.js";
import { statsModel } from "./model.js";
import { DEFAULTS, isSimulated, legRange, shortlist, rankMatches, applyNews, fallbackSlip, merge, poolFor, optimiseNear, shortNote } from "./slips.js";

// Stage 1  extract past stats (form, goals, table position, home and away record, match type) for every available match
// Stage 2  run the stats model over all of them and rank them, keeping every match that has data behind it
// Stage 3  web news (Tavily, at most newsCalls searches), then the AI predictors read it and rate each team
// Stage 4  blend the sources, compute the best combination that lands on the target, let the AI selector review it
// prepare() is stages 1 and 2 and runs once. solve() is stage 4 and runs once per set of predictions.

export async function prepare({ matches, kinds = null, sport = "football", opts = {}, enrich = enrichAll, log = console.log }) {
  const o = { ...DEFAULTS, ...opts };
  const warnings = [];
  const real = matches.filter((m) => !isSimulated(m));
  const simulated = matches.length - real.length;
  if (simulated) warnings.push(`Skipped ${simulated} simulated (SRL or virtual) matches. Their results are random, so stats and form mean nothing.`);

  // Stage 1. Only trims when there are more matches than maxEnrich, using the market as a cheap pre-cut.
  const pool = shortlist(real, kinds, o.maxEnrich, o);
  log(`Stage 1: extracting past stats for ${pool.length} of ${real.length} available matches`);
  const found = await enrich(pool, pool.length, sport);
  const { count, warning } = found;
  if (warning) warnings.push(`Past performance: ${warning}`);
  const split = found.espn !== undefined ? ` (ESPN ${found.espn}, API Ninjas ${found.ninjas})` : "";
  log(`Stage 1: found stats for ${count} of ${pool.length} matches${split}\n`);
  log(statsMarkdown(pool));

  // Stage 2. With past data required, a match the stats model cannot rate is left out. All the others are kept, best first.
  let usable = pool;
  if (o.requireStats) {
    usable = pool.filter((m) => statsModel(m));
    const dropped = pool.length - usable.length;
    if (dropped) warnings.push(`${dropped} of ${pool.length} matches had no usable past data (league not covered, or fewer than 5 games played) and were left out. Untick "Only matches with past data" to bring them back on market and AI alone.`);
  }
  const list = rankMatches(usable, kinds, o);
  log(`Stage 2: the stats model ranked ${usable.length} matches. Top: ${list.slice(0, 5).map((m) => `${m.home} v ${m.away}`).join("; ")}${list.length > 5 ? "; ..." : ""}\n`);
  return { list, pool, warnings, enriched: count };
}

export async function solve({
  list, predsList, selectorModel = null, kinds = null, targets, unique = true, opts = {},
  selectFn = select, log = console.log, title = "",
}) {
  const o = { ...DEFAULTS, ...opts };
  const preds = merge(predsList);
  const used = new Set();
  const slips = [];
  const { min, max } = legRange(o);
  applyNews(list, preds);
  log(sentimentMarkdown(list, title));
  for (const target of targets) {
    applyNews(list, preds); // shared matches: re-apply this set's ratings right before use
    const pool = poolFor(list, preds, kinds, used, max, o);
    pool.sort((a, b) => b.prob - a.prob).forEach((l, i) => { l.id = `L${i + 1}`; });
    const base = optimiseNear(pool, target, min, max, o.tolerance) || fallbackSlip(pool, target, min, max, o.tolerance);
    if (!base) {
      slips.push({ target, legs: [], note: shortNote(pool, target, min, max, o.minProb) });
      continue;
    }
    if (base.tol > o.tolerance && !base.relaxed) {
      base.relaxed = `Nothing landed within ${Math.round(o.tolerance * 100)}% above ${target}x with these matches, so this slip is allowed up to ${Math.round(base.tol * 100)}% above (it lands at ${base.odds.toFixed(2)}x).`;
    }
    const range = base.range ?? { min, max };
    // The AI selector only reviews slips that meet the target. A "closest" slip cannot, so it is shown as computed.
    const maxOdds = base.tol != null ? target * (1 + base.tol) * 1.03 : null;
    const picked = base.kind === "closest"
      ? { ...base, source: "closest" }
      : await selectFn({ model: selectorModel, target, min: range.min, max: range.max, maxOdds, pool, base, matches: list });
    if (unique) picked.legs.forEach((l) => used.add(l.matchId));
    slips.push({ target, minLegs: range.min, maxLegs: range.max, ...picked, ...(base.relaxed ? { relaxed: base.relaxed, note: base.relaxed } : {}) });
  }
  log(`Slips built${title ? ` for ${title}` : ""}\n`);
  log(slipMarkdown(slips));
  return slips;
}

// Everything in one call, for scripts and tests.
export async function runPipeline({
  matches, models = [], selectorModel = null, news = true, kinds = null, targets, unique = true, sport = "football", opts = {},
  log = console.log, enrich = enrichAll, predictFn = predict, selectFn = select, newsFn = researchNews,
}) {
  const prep = await prepare({ matches, kinds, sport, opts, enrich, log });
  const warnings = [...prep.warnings];
  if (news) {
    const n = await newsFn(prep.list, { maxCalls: opts.newsCalls ?? DEFAULTS.newsCalls, log });
    if (n.warning) warnings.push(n.warning);
  }
  const settled = await Promise.allSettled(models.map((md) => predictFn(md, prep.list)));
  const predsList = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") predsList.push(r.value);
    else warnings.push(`Model ${models[i]} failed: ${r.reason?.message || r.reason}`);
  });
  log(`Stage 3: ${predsList.length} of ${models.length} AI predictors answered\n`);
  const slips = await solve({ list: prep.list, predsList, selectorModel, kinds, targets, unique, opts, selectFn, log });
  return { slips, warnings };
}