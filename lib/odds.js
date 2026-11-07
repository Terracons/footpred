import { unstable_cache } from "next/cache";
import { devig } from "./devig.js";

const HOST = "https://api.oddspapi.io/v4";
const SLUG = process.env.STAKE_SLUG || "stake";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Small responses are cached. Pass revalidate 0 for huge ones, which Next cannot cache (2MB limit).
async function get(path, params, revalidate = 3600) {
  if (!process.env.ODDSPAPI_KEY) throw new Error("ODDSPAPI_KEY is not set");
  const qs = new URLSearchParams({ ...params, apiKey: process.env.ODDSPAPI_KEY });
  const res = await fetch(`${HOST}${path}?${qs}`, revalidate ? { next: { revalidate } } : { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 150);
    throw new Error(`OddsPapi ${path} ${JSON.stringify(params)} failed with status ${res.status} ${body}`);
  }
  return res.json();
}

// Used when the market list endpoint is unavailable. IDs come from OddsPapi docs and examples.
const FALLBACK = new Map([
  ["101", { name: "Full Time Result", handicap: 0, kind: "result",
    outcomes: [{ outcomeId: 101, outcomeName: "1" }, { outcomeId: 102, outcomeName: "X" }, { outcomeId: 103, outcomeName: "2" }] }],
  ["104", { name: "Both Teams To Score", handicap: 0, kind: "btts",
    outcomes: [{ outcomeId: 104, outcomeName: "Yes" }, { outcomeId: 105, outcomeName: "No" }] }],
  ["1010", { name: "Over/Under 2.5", handicap: 2.5, kind: "totals",
    outcomes: [{ outcomeId: 1010, outcomeName: "Over" }, { outcomeId: 1011, outcomeName: "Under" }] }],
]);

// Full time result, double chance, both teams to score and goal totals (1.5 to 4.5).
async function getCatalog() {
  let rows = null;
  for (const params of [{ sportId: 10 }, {}]) {
    try {
      rows = await get("/markets", params, 86400);
      break;
    } catch (e) {
      if (/not set/.test(e.message)) throw e;
    }
  }
  if (!rows) return FALLBACK;
  // Names are matched exactly. A loose match such as /Over Under Full Time/ also catches cards, bookings, shots and other
  // totals, which then get treated as goals (a 1.94 "Under 4.5 goals" is really cards). Anything near-matching but not
  // exact is listed in the server log so a wrong name can be spotted and added here.
  const STRICT = {
    result: /^Full Time Result$/i,
    dc: /^Double Chance( Full Time)?$/i,
    btts: /^Both Teams To Score( Full Time)?$/i,
    goals: /^Over Under Full Time$/i,
  };
  const CORNER_OK = (n) => /Corner/i.test(n) && /Over Under/i.test(n) && !/Team|Half|1st|2nd|Asian|Exact|Odd|Even|Handicap|Race|Most|Alternative|Player/i.test(n);
  const loose = /Full Time Result|Double Chance|Both Teams To Score|Over Under/i;
  const out = new Map();
  const seen = new Set(); // one market per kind and line, so a duplicate name cannot double a leg
  const rejected = new Set();
  for (const m of rows) {
    if ((m.sportId !== undefined && m.sportId !== 10) || m.playerProp || m.period !== "fulltime") continue;
    const name = String(m.marketName || "").trim();
    const corners = CORNER_OK(name);
    const isGoals = STRICT.goals.test(name);
    const strict = STRICT.result.test(name) || STRICT.dc.test(name) || STRICT.btts.test(name) || isGoals || corners;
    if (!strict) { if (loose.test(name) || /Corner/i.test(name)) rejected.add(name); continue; }
    const line = Number(m.handicap);
    // Only x.5 lines: quarter lines (2.75) can be half won or half lost and whole lines (3) can be refunded,
    // so neither is a clean win or lose leg for an accumulator.
    const clean = Number.isFinite(line) && !Number.isInteger(line) && (line * 2) % 1 === 0;
    if (isGoals && (!clean || line < 1.5 || line > 4.5)) continue;
    if (corners && (!clean || line < 6.5 || line > 13.5)) continue;
    const kind = corners ? "corners" : isGoals ? "totals" : STRICT.btts.test(name) ? "btts" : "result";
    const key = `${kind}:${kind === "totals" || kind === "corners" ? line : name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.set(String(m.marketId), {
      name: corners ? `Corners Over/Under ${line}` : isGoals ? `Over/Under ${line}` : name,
      handicap: m.handicap, outcomes: m.outcomes, kind,
    });
  }
  if (rejected.size) console.warn(`OddsPapi markets ignored (name not an exact match): ${[...rejected].slice(0, 12).join(" | ")}`);
  return out.size ? out : FALLBACK;
}

function label(mk, o, home, away) {
  const n = o.outcomeName;
  if (/Full Time Result/i.test(mk.name)) return n === "1" ? `${home} to win` : n === "2" ? `${away} to win` : "Draw";
  if (mk.kind === "totals") return `${n} ${mk.handicap} goals`;
  if (mk.kind === "corners") return `${n} ${mk.handicap} corners`;
  if (mk.kind === "btts") return `Both teams to score: ${n}`;
  return `${mk.name}: ${n}`;
}

async function loadMatches(hours = 47, limit = 30, fromHours = 0, leagues = "") {
  const slug = SLUG;
  const catalog = await getCatalog();
  const now = new Date();
  const begin = new Date(now.getTime() + fromHours * 3600 * 1000);
  const cutoff = new Date(begin.getTime() + hours * 3600 * 1000);
  const day = (d) => d.toISOString().slice(0, 10); // date only, as in the OddsPapi docs
  const range = { sportId: 10, from: day(begin), to: day(new Date(cutoff.getTime() + 86400000)), statusId: 0 };
  // League filter: words from league or team names; a leading minus leaves matches out.
  const words = String(leagues || "").toLowerCase().split(",").map((w) => w.trim()).filter(Boolean);
  const inc = words.filter((w) => !w.startsWith("-"));
  const exc = words.filter((w) => w.startsWith("-")).map((w) => w.slice(1).trim()).filter(Boolean);
  const wanted = (f) => {
    const hay = `${f.tournamentName} ${f.participant1Name} ${f.participant2Name}`.toLowerCase();
    return (!inc.length || inc.some((w) => hay.includes(w))) && !exc.some((w) => hay.includes(w));
  };
  let fixtures;
  try {
    fixtures = await get("/fixtures", { ...range, hasOdds: true, bookmakers: slug });
  } catch (e) {
    if (!/status 404/.test(e.message)) throw e;
    await sleep(2100);
    fixtures = await get("/fixtures", range); // retry without the bookmaker filter
  }
  if (!Array.isArray(fixtures)) throw new Error("OddsPapi /fixtures returned an unexpected response");
  fixtures = fixtures.filter((f) => new Date(f.startTime) > begin && new Date(f.startTime) < cutoff && wanted(f));
  if (!fixtures.length) throw new Error(`No Stake fixtures with odds found between ${fromHours} and ${fromHours + hours} hours from now`);
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const counts = {};
  fixtures.forEach((f) => { counts[f.tournamentId] = (counts[f.tournamentId] || 0) + 1; });
  const tids = Object.keys(counts).sort((x, y) => counts[y] - counts[x]).slice(0, 12); // busiest leagues first
  const matches = [];
  for (let i = 0; i < tids.length; i += 4) {
    await sleep(2100);
    const rows = await get("/odds-by-tournaments", {
      bookmaker: slug, tournamentIds: tids.slice(i, i + 4).join(","),
    }, 0);
    for (const row of rows) {
      const fx = byId.get(row.fixtureId);
      if (!fx) continue;
      const bm = row.bookmakerOdds?.[slug]?.markets ?? {};
      const markets = [];
      for (const [mid, mk] of catalog) {
        const outs = bm[mid]?.outcomes;
        if (!outs) continue;
        const items = mk.outcomes.map((o) => {
          const p = outs[o.outcomeId]?.players?.["0"];
          return p && p.active !== false && p.price > 1
            ? { oid: String(o.outcomeId), n: o.outcomeName, label: label(mk, o, fx.participant1Name, fx.participant2Name), odds: p.price }
            : null;
        });
        if (items.some((x) => !x)) continue; // need every outcome to remove the margin
        const sumTo = /Double Chance/i.test(mk.name) ? 2 : 1; // two of three outcomes win in double chance
        const fair = devig(items.map((x) => x.odds), sumTo); // power method, see devig.js
        markets.push({
          mid, name: mk.name, kind: mk.kind, handicap: mk.handicap, sumTo, margin: fair.margin,
          outcomes: items.map((x, i) => ({ ...x, fair: fair.p[i] })),
        });
      }
      if (!markets.length) continue;
      matches.push({
        id: row.fixtureId, home: fx.participant1Name, away: fx.participant2Name,
        league: fx.tournamentName, start: fx.startTime, markets,
      });
    }
  }
  return matches.sort((a, b) => a.start.localeCompare(b.start)).slice(0, limit);
}

// The processed matches are small, so cache those for an hour instead of the raw responses.
export const getMatches = unstable_cache(loadMatches, ["stake-matches-v6"], { revalidate: 3600 });