import { statsModel, resultType } from "./model.js";

// How much each source counts. Stats weight is scaled by the model's confidence (sample size, match type).
// How much each source counts. The market is the sharpest source, so it leads. The AI has no live data, so it
// counts least. The stats weight is scaled by the model's confidence (sample size, match type). Override with opts.weights.
const W = { market: 0.6, ai: 0.05, stats: 0.3 };
export const DEFAULTS = {
  minProb: 0, // optional hard floor per leg. 0 = no cut-off, the optimiser simply maximises the combined chance
  requireStats: false, // true = only legs with table and form data behind them
  minLegOdds: 1.05, // legs shorter than this add nothing. Safe short legs are welcome: they help reach a minimum leg count at almost no cost
  extraLegs: 2, // a slip may use up to this many legs above the minimum (unless maxLegs is given)
  tolerance: 0.08, // a slip should land between the target and this fraction above it (relaxed step by step if impossible)
  maxLegOdds: Infinity, // optional cap on the odds of a single leg
  minEV: -0.25, // value check: a leg whose cautious chance times its odds minus 1 is below this is dropped (-Infinity = off)
  maxGap: 0.3, // abstain on a leg when the stats model and the market differ by more than this: bad data or a mis-read market
  pool: 0, // 0 = size the candidate pool from the leg range
  maxEnrich: 40, // stats are extracted for up to this many matches before any selection is made
  newsCalls: 10, // web news searches per run (one per match, best ranked first). Tavily basic search costs 1 credit each
  // Multipliers used only when choosing between legs (the leg's shown chance is not changed).
  // They favour 1, 2, 1X and X2 and disfavour 12, enough to decide between close calls but not to override a clearly
  // likelier leg. Raise the gap for a stronger preference (each step costs some win chance). Set { } to switch it off.
  pref: { "1": 1.03, "2": 1.03, "1X": 1.02, X2: 1.02, "12": 0.92 },
};

// [target odds, minimum number of matches]. Targets in between use the tier below them.
const LEG_RULES = [[4, 5], [10, 10], [20, 20], [50, 20]];

export function legRange(target, o = {}) {
  let min = o.minLegs;
  if (!min) {
    const tier = [...LEG_RULES].reverse().find(([t]) => target >= t);
    min = tier ? tier[1] : Math.max(2, Math.ceil(target * 1.25));
  }
  const max = Math.max(min, o.maxLegs ?? min + (o.extraLegs ?? DEFAULTS.extraLegs));
  return { min, max };
}

// How many matches to analyse before choosing: twice the minimum legs, so there is something to choose from.
export function shortlistSize(target, o = {}) {
  const { min } = legRange(target, o);
  return Math.max(min * 2, min + 6);
}

// Team news ratings from the predictors: sentiment and confidence are averaged, risk takes the highest level.
function mergeNews(list) {
  if (!list.length) return null;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0));
  const avg = (f) => list.reduce((a, n) => a + f(n), 0) / list.length;
  const rank = { low: 0, medium: 1, high: 2 };
  const risk = list.map((n) => n.risk).filter((r) => r in rank).sort((a, b) => rank[b] - rank[a])[0] || "low";
  return { home: avg((n) => clamp(n.home, -2, 2)), away: avg((n) => clamp(n.away, -2, 2)), confidence: avg((n) => clamp(n.confidence, 0, 1)), risk };
}

// Sets (or clears) m.news from this set of predictions. Call it right before building legs: matches are shared
// between sets running at the same time, so each set must apply its own ratings just before it uses them.
export function applyNews(list, preds) {
  for (const m of list) {
    const n = preds[m.id]?.news;
    if (n) m.news = n; else delete m.news;
  }
}

// Average several models' probabilities for the same outcome.
export function merge(list) {
  const acc = {};
  for (const preds of list) {
    for (const [id, pr] of Object.entries(preds)) {
      const o = (acc[id] ??= { sum: {}, n: {}, reason: pr.reason, news: [] });
      if (pr.news && typeof pr.news === "object") o.news.push(pr.news);
      for (const [k, v] of Object.entries(pr.p || {})) {
        const x = Number(v);
        if (x > 0) { o.sum[k] = (o.sum[k] || 0) + x; o.n[k] = (o.n[k] || 0) + 1; }
      }
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([id, o]) => [
    id, { reason: o.reason, news: mergeNews(o.news), p: Object.fromEntries(Object.keys(o.sum).map((k) => [k, o.sum[k] / o.n[k]])) },
  ]));
}

// Stake's "SRL" and similar are simulated games with random results. Team stats mean nothing for them.
export const isSimulated = (m) => /\bSRL\b|esoccer|e-soccer|virtual|cyber|simulated|\bebasketball\b/i.test(`${m.league} ${m.home} ${m.away}`);

// Stage 1: cheap ranking with no API calls. A match is a likely candidate if the market already
// rates one of its outcomes highly. Takes the top n.
// ---- Market selection -------------------------------------------------------------------------------------------
// Chooses which outcomes may become legs. It works on single outcomes, so "Over alone" or "double chance 1X and X2
// only" are possible. The AI and the stats model still see whole markets (probabilities must sum properly); only the
// choice of legs is restricted. Combine keys freely, for example ["doublechance", "over"].
const OVER_UNDER = /^(over|under)(\d+(?:\.\d+)?)$/;
const TYPES = (...t) => (mk, o) => t.includes(resultType(mk, o));
const RULES = {
  result: TYPES("1", "X", "2"), // Full Time Result: home, draw, away
  win: TYPES("1", "2"), // home or away win, no draw
  draw: TYPES("X"),
  doublechance: TYPES("1X", "X2", "12"),
  dc_no12: TYPES("1X", "X2"), // double chance without 12
  dc_12: TYPES("12"), // double chance 12 only (home or away, no draw)
  dc_1x: TYPES("1X"),
  dc_x2: TYPES("X2"),
  over: (mk, o) => mk.kind === "totals" && /over/i.test(o.n),
  under: (mk, o) => mk.kind === "totals" && /under/i.test(o.n),
  totals: (mk) => mk.kind === "totals", // over and under
  btts: (mk) => mk.kind === "btts", // yes and no
  btts_yes: (mk, o) => mk.kind === "btts" && /yes/i.test(o.n),
  btts_no: (mk, o) => mk.kind === "btts" && /no/i.test(o.n),
  corners: (mk) => mk.kind === "corners", // corner over and under
  corners_over: (mk, o) => mk.kind === "corners" && /over/i.test(o.n),
  corners_under: (mk, o) => mk.kind === "corners" && /under/i.test(o.n),
};
export const MARKET_OPTIONS = [
  { key: "result", label: "Result (1, X, 2)" },
  { key: "win", label: "Win only (1 or 2)" },
  { key: "doublechance", label: "Double chance (1X, X2, 12)" },
  { key: "dc_no12", label: "Double chance 1X or X2 only" },
  { key: "dc_12", label: "Double chance 12 only" },
  { key: "over", label: "Over (any line)" },
  { key: "under", label: "Under (any line)" },
  { key: "totals", label: "Over and under" },
  { key: "btts_yes", label: "Both teams to score: Yes" },
  { key: "btts_no", label: "Both teams to score: No" },
  { key: "btts", label: "Both teams to score (yes or no)" },
  { key: "corners", label: "Corners (over and under)" },
  { key: "corners_over", label: "Corners: Over only" },
  { key: "corners_under", label: "Corners: Under only" },
]; // also accepted: draw, and a single line such as over1.5 or under3.5

const isKnown = (k) => k in RULES || OVER_UNDER.test(k);

// Reads a request value ("over", "over,under", ["doublechance", "over"], "all"). sel is null for every market.
export function parseMarkets(input) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : [];
  const keys = [...new Set(raw.map((k) => String(k).trim().toLowerCase()).filter(Boolean))];
  if (!keys.length || keys.includes("all")) return { sel: null, unknown: [] };
  return { sel: keys.filter(isKnown), unknown: keys.filter((k) => !isKnown(k)) };
}

// (market, outcome) => allowed? Returns null when nothing is restricted.
export function outcomeFilter(sel) {
  if (!sel || !sel.length) return null;
  const rules = sel.filter(isKnown).map((k) => {
    const m = OVER_UNDER.exec(k);
    if (!m) return RULES[k];
    return (mk, o) => mk.kind === "totals" && new RegExp(m[1], "i").test(o.n) && Number(mk.handicap) === Number(m[2]);
  });
  return rules.length ? (mk, o) => rules.some((r) => r(mk, o)) : null;
}

export function shortlist(matches, kinds, n, o = {}) {
  const minLegOdds = o.minLegOdds ?? DEFAULTS.minLegOdds;
  const pass = outcomeFilter(kinds);
  const score = (m) => {
    let best = 0;
    for (const mk of m.markets) {
      for (const x of mk.outcomes) if ((!pass || pass(mk, x)) && x.odds >= minLegOdds && x.fair > best) best = x.fair;
    }
    return best;
  };
  return matches.filter((m) => !isSimulated(m)).map((m) => ({ m, s: score(m) })).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.m)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// Stage 2 ranking, after stats were extracted: how favourable is each match? Uses the stats model and the market
// (the AI has not run yet). Matches with no stats are scored from the market alone, minus a margin, so they can
// still compete but need to be clearly better. Returns the matches best first.
export function rankMatches(matches, kinds, o = {}) {
  const opts = { ...DEFAULTS, ...o };
  const pass = outcomeFilter(kinds);
  const marketOnly = (m) => {
    let best = 0;
    for (const mk of m.markets) {
      for (const x of mk.outcomes) if ((!pass || pass(mk, x)) && x.odds >= opts.minLegOdds) best = Math.max(best, x.fair * (opts.pref?.[resultType(mk, x)] ?? 1));
    }
    return best - 0.08;
  };
  return matches
    .map((m) => {
      const c = candidatesFor(m, {}, kinds, opts);
      return { m, s: c.length ? Math.max(...c.map((x) => x.score)) : marketOnly(m) };
    })
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
}

// The AI's numbers for one match as a map "marketId:outcomeId" -> chance, made coherent so they cannot contradict each other:
//  - every market is rescaled to its total (1, or 2 for double chance)
//  - double chance is taken from the AI's own 1X2 (1X = home + draw, X2 = draw + away, 12 = home + away), so 1X can never
//    be lower than the home win
//  - Over chances never rise as the line goes up (Over 2.5 cannot beat Over 1.5), and Under is 1 minus Over
function aiMap(m, pred) {
  const ai = {};
  if (!pred?.p) return ai;
  for (const mk of m.markets) {
    const raw = mk.outcomes.map((o) => Number(pred.p[`${mk.mid}:${o.oid}`]));
    if (!raw.every((v) => v > 0)) continue;
    const sum = raw.reduce((a, b) => a + b, 0);
    const sumTo = mk.sumTo || 1;
    mk.outcomes.forEach((o, i) => { ai[`${mk.mid}:${o.oid}`] = Math.min(0.99, (raw[i] / sum) * sumTo); });
  }
  const t = {};
  for (const mk of m.markets) {
    for (const o of mk.outcomes) {
      const ty = resultType(mk, o);
      const v = ai[`${mk.mid}:${o.oid}`];
      if ((ty === "1" || ty === "X" || ty === "2") && v != null) t[ty] = v;
    }
  }
  if (t["1"] != null && t.X != null && t["2"] != null) {
    const dc = { "1X": t["1"] + t.X, X2: t.X + t["2"], "12": t["1"] + t["2"] };
    for (const mk of m.markets) {
      for (const o of mk.outcomes) {
        const ty = resultType(mk, o);
        if (ty && dc[ty] != null) ai[`${mk.mid}:${o.oid}`] = Math.min(0.99, dc[ty]);
      }
    }
  }
  let prev = 1;
  for (const mk of m.markets.filter((x) => x.kind === "totals" && Number.isFinite(x.handicap)).sort((a, b) => a.handicap - b.handicap)) {
    const over = mk.outcomes.find((o) => /over/i.test(o.n));
    const under = mk.outcomes.find((o) => /under/i.test(o.n));
    const key = over && `${mk.mid}:${over.oid}`;
    if (!over || ai[key] == null) continue;
    ai[key] = Math.min(ai[key], prev);
    prev = ai[key];
    if (under) ai[`${mk.mid}:${under.oid}`] = 1 - ai[key];
  }
  return ai;
}

// Legs for one match. Three sources are blended: the no-vig market, the AI and the stats model (form, goals, table).
// The blended chance is then lowered when the sources disagree (by their weighted spread),
// for cup and European ties, and when there are no stats behind the match. Nothing is rated above 97%, because
// no football leg is that certain. Of all outcomes, only the ones not beaten on both chance and odds by another
// outcome are kept (at most 5), so the optimiser can trade chance for odds.
export function candidatesFor(m, pred, kinds, opts = {}) {
  const { minProb, requireStats, minLegOdds, maxLegOdds, allowDraw, pref, weights, minEV, maxGap } = { ...DEFAULTS, ...opts };
  const wantsDraw = allowDraw !== false || (kinds || []).some((k) => k === "draw");
  const W_ = { ...W, ...weights };
  const sm = statsModel(m);
  const ai = aiMap(m, pred);
  const hasAi = Object.keys(ai).length > 0;
  if (requireStats && !sm) return [];
  const penalty = (m.stats && m.stats.kind !== "league" ? 0.02 : 0) + (sm ? 0 : 0.03) + (hasAi || sm ? 0 : 0.06) + ({ high: 0.04, medium: 0.02 }[m.news?.risk] || 0);
  const pass = outcomeFilter(kinds);
  const out = [];
  for (const mk of m.markets) {
    for (const o of mk.outcomes) {
      if (o.odds < minLegOdds || o.odds > maxLegOdds || (pass && !pass(mk, o))) continue;
      if (!wantsDraw && resultType(mk, o) === "X") continue;
      const src = { market: o.fair };
      const a = ai[`${mk.mid}:${o.oid}`];
      if (a != null) src.ai = a;
      const sp = sm?.prob(mk, o);
      if (sp != null) src.stats = sp;
      if (sp != null && Math.abs(sp - src.market) > maxGap) continue; // model disagreement: abstain rather than average two incompatible views
      const w = { market: W_.market, ai: a != null ? W_.ai : 0, stats: sp != null ? W_.stats * sm.conf : 0 };
      const wSum = w.market + w.ai + w.stats;
      const blend = (w.market * src.market + w.ai * (src.ai || 0) + w.stats * (src.stats || 0)) / wSum;
      // Disagreement haircut: the weighted standard deviation of the sources around the blend. A source with a small
      // weight (the AI) can only move it a little, while the market and the stats model disagreeing costs a lot.
      const sd = Math.sqrt((w.market * (src.market - blend) ** 2 + w.ai * ((src.ai ?? blend) - blend) ** 2 + w.stats * ((src.stats ?? blend) - blend) ** 2) / wSum);
      // Corners have no model here (no corner data), so they rest on the market alone and carry an extra margin.
      const prob = Math.min(0.97, Math.max(0.01, blend - sd - penalty - (sp == null && mk.kind === "corners" ? 0.04 : 0)));
      if (prob < minProb) continue;
      const ev = prob * o.odds - 1; // simplified expected return per unit stake, on the cautious chance
      if (ev < minEV) continue;
      const type = resultType(mk, o);
      out.push({
        matchId: m.id, match: `${m.home} v ${m.away}`, league: m.league, start: m.start,
        label: o.label, odds: o.odds, prob, ev, modelled: sp != null, type, score: prob * (pref?.[type] ?? 1), eff: Math.log(o.odds) / -Math.log(prob), reason: pred.reason || "",
        matchType: m.stats?.kind || "unknown",
        sources: Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Math.round(v * 100) / 100])),
      });
    }
  }
  out.sort((a, b) => b.score - a.score);
  const keep = [];
  let top = 0;
  for (const c of out) if (c.odds > top) { keep.push(c); top = c.odds; }
  return keep.slice(0, 5);
}

// Keeps the k matches with the likeliest legs, with all their candidates.
function topPool(cands, k) {
  const by = new Map();
  for (const c of cands) (by.get(c.matchId) ?? by.set(c.matchId, []).get(c.matchId)).push(c);
  return [...by.values()]
    .sort((a, b) => Math.max(...b.map((x) => x.score)) - Math.max(...a.map((x) => x.score)))
    .slice(0, k).flat();
}

// The slip with the highest combined probability that reaches the target odds using between min and max
// legs, one per match. Dynamic programming over (legs used, log odds reached). Log odds are rounded down,
// so a slip it returns always really does reach the target.
// capMult (optional, for example 1.08) also stops the slip from landing above target * capMult.
export function optimise(pool, target, min, max, capMult = null) {
  const STEP = 0.002;
  const need = Math.ceil(Math.log(target) / STEP);
  const hi = capMult ? Math.max(need, Math.floor(Math.log(target * capMult) / STEP)) : need;
  const Wd = hi + 1;
  const size = (max + 1) * Wd;
  const by = new Map();
  for (const c of pool) {
    const leg = { c, lo: Math.floor(Math.log(c.odds) / STEP), lp: Math.log(c.score ?? c.prob) };
    (by.get(c.matchId) ?? by.set(c.matchId, []).get(c.matchId)).push(leg);
  }
  const groups = [...by.values()];
  let cur = new Float64Array(size).fill(-Infinity);
  cur[0] = 0;
  const trail = [];
  for (const g of groups) {
    const next = new Float64Array(size).fill(-Infinity);
    const choice = new Int8Array(size).fill(-1);
    const prevB = new Int32Array(size);
    for (let c = 0; c <= max; c++) {
      for (let b = 0; b <= hi; b++) {
        const k = c * Wd + b;
        const v = cur[k];
        if (v === -Infinity) continue;
        if (v > next[k]) { next[k] = v; choice[k] = -1; prevB[k] = b; }
        if (c < max) {
          g.forEach((leg, j) => {
            const nb = capMult ? b + leg.lo : Math.min(need, b + leg.lo);
            if (nb > hi) return;
            const nk = (c + 1) * Wd + nb;
            const nv = v + leg.lp;
            if (nv > next[nk]) { next[nk] = nv; choice[nk] = j; prevB[nk] = b; }
          });
        }
      }
    }
    trail.push({ choice, prevB });
    cur = next;
  }
  let bestC = -1;
  let bestB = need;
  let bestV = -Infinity;
  for (let c = min; c <= max; c++) {
    for (let bb = need; bb <= hi; bb++) {
      const v = cur[c * Wd + bb];
      if (v > bestV) { bestV = v; bestC = c; bestB = bb; }
    }
  }
  if (bestC < 0) return null;
  const legs = [];
  let c = bestC;
  let b = bestB;
  for (let i = groups.length - 1; i >= 0; i--) {
    const k = c * Wd + b;
    const j = trail[i].choice[k];
    const pb = trail[i].prevB[k];
    if (j >= 0) { legs.push(groups[i][j].c); c--; }
    b = pb;
  }
  legs.reverse();
  const odds = legs.reduce((a, l) => a * l.odds, 1);
  const prob = legs.reduce((a, l) => a * l.prob, 1);
  return { legs, odds, prob, expected: prob * odds };
}

// Best slip that lands between the target and target * (1 + tolerance). When nothing fits, the band is widened step by step
// and the slip says how wide it had to be (tol). null when even a doubled band has no solution.
export function optimiseNear(pool, target, min, max, tolerance = DEFAULTS.tolerance) {
  const steps = [...new Set([tolerance, 0.15, 0.25, 0.5, 1].filter((t) => t >= tolerance))].sort((a, b) => a - b);
  for (const tol of steps) {
    const r = optimise(pool, target, min, max, 1 + tol);
    if (r && r.odds <= target * (1 + tol) * 1.03) return { ...r, tol };
  }
  return null;
}

// When the rules cannot be met, a slip is still returned:
//  1. "relaxed": the minimum leg count is dropped (there are not enough usable matches) and the target is still reached.
//  2. "closest": the target is out of reach, so this is the highest-odds slip the matches allow (longest leg of every match).
// The result says which one it is, so the slip is never mistaken for one that met the rules.
export function fallbackSlip(pool, target, min, max, _tolerance) {
  const n = new Set(pool.map((l) => l.matchId)).size;
  if (!n) return null;
  const hi = Math.max(max, n);
  const r = optimise(pool, target, 1, hi);
  if (r) {
    return { ...r, kind: "relaxed", range: { min: 1, max: hi },
      relaxed: `Only ${n} usable matches, fewer than the ${min} legs this target normally uses, so this slip has ${r.legs.length} legs and a lower win chance than a full slip would have.` };
  }
  const best = new Map();
  for (const c of pool) if (!best.has(c.matchId) || c.odds > best.get(c.matchId).odds) best.set(c.matchId, c);
  const legs = [...best.values()].sort((a, b) => b.odds - a.odds);
  const odds = legs.reduce((a, l) => a * l.odds, 1);
  const prob = legs.reduce((a, l) => a * l.prob, 1);
  return { legs, odds, prob, expected: prob * odds, kind: "closest", range: { min: 1, max: hi },
    relaxed: `${target}x is out of reach with ${legs.length} usable matches. This is the highest-odds slip they allow (${odds.toFixed(2)}x), so its win chance is low.` };
}

export function poolFor(matches, preds, kinds, used, max, opts = {}) {
  const k = opts.pool || 2 * max + 4;
  const cands = matches.filter((m) => !used.has(m.id)).flatMap((m) => candidatesFor(m, preds[m.id] || {}, kinds, opts));
  return topPool(cands, k);
}

export function shortNote(pool, target, min, max, minProb) {
  const legs = new Set(pool.map((l) => l.matchId)).size;
  const reach = [...pool].sort((a, b) => b.odds - a.odds).slice(0, max).reduce((a, l) => a * l.odds, 1);
  const floor = minProb > 0 ? ` with a ${Math.round(minProb * 100)}% floor per leg` : "";
  if (!legs) return `No usable legs${floor}. Try a longer window or more matches.`;
  if (legs < min) return `Only ${legs} real matches had usable legs${floor} and ${min} are needed for ${target}x. Try a longer window or a lower target.`;
  return `No combination of ${min} to ${max} legs reaches ${target}x${floor}. The best available is about ${reach.toFixed(2)}x. Try a longer window or a lower target.`;
}

// Single-stage version without the AI selector. runPipeline in pipeline.js is the full flow.
export function buildSlips(matches, predsList, kinds, targets, unique = true, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const preds = merge(predsList);
  const used = new Set();
  return targets.map((target) => {
    const { min, max } = legRange(target, o);
    const pool = poolFor(matches, preds, kinds, used, max, o);
    const best = optimise(pool, target, min, max) || fallbackSlip(pool, target, min, max);
    if (!best) return { target, legs: [], note: shortNote(pool, target, min, max, o.minProb) };
    if (unique) best.legs.forEach((l) => used.add(l.matchId));
    return { target, ...best, ...(best.relaxed ? { note: best.relaxed } : {}) };
  });
}