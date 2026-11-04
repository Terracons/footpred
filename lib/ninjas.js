// Fallback past-performance source: API Ninjas football. Used only for matches ESPN returned nothing for.
// Covers most European and other leagues the API lists (J1, Saudi, Brazil, Mexico, ...), plus the UEFA, AFC and South American
// club competitions for clubs with no domestic data. J2 and J3 are not covered. Needs API_NINJAS_KEY.
// The free plan includes finished-match scores, standings and clubs. Live values are premium, which we do not use.
import { applyStats } from "./espn.js";

const HOST = "https://api.api-ninjas.com/v1";
// Domestic leagues the API lists clubs for. Looked up lazily and cached for a day, so a league is only
// requested when a team was not found in the ones before it.
const DOMESTIC = [
  "epl", "laliga", "bundesliga", "seriea", "ligue1", "mls", "championship", "laliga2", "bundesliga2", "serieb", "ligue2",
  "eredivisie", "primeiraliga", "superlig", "belgianproleague", "scottishpremiership", "greeksuperleague", "austrianbundesliga",
  "danishsuperliga", "j1league", "saudiproleague", "brasileirao", "ligamx", "ligaprofesional", "aleague", "csl",
];
// Clubs from other countries' leagues (Turkey, Portugal, Ukraine, ...) are only listed under the UEFA competitions.
// For those the Champions League or Europa League season is the only data available.
const EURO = ["ucl", "uel", "uecl", "acl", "libertadores", "sudamericana"];
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

async function get(path, params, revalidate) {
  const res = await fetch(`${HOST}${path}?${new URLSearchParams(params)}`, {
    headers: { "X-Api-Key": process.env.API_NINJAS_KEY },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`API Ninjas ${path} failed with status ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j)) throw new Error(`API Ninjas ${path} returned an unexpected response`);
  return j;
}

const clubLists = new Map();
function clubsOf(lg) {
  if (!clubLists.has(lg)) clubLists.set(lg, get("/soccerclubs", { league: lg }, 86400).catch(() => []));
  return clubLists.get(lg);
}

function find(clubs, name) {
  const n = norm(name);
  const names = (c) => [c.name, c.short_name].filter(Boolean).map(norm);
  return clubs.find((c) => names(c).includes(n))
    || clubs.find((c) => n.length >= 5 && names(c).some((x) => x.length >= 5 && (x.includes(n) || n.includes(x))));
}

async function locate(m) {
  for (const lg of DOMESTIC) {
    const clubs = await clubsOf(lg);
    const h = find(clubs, m.home);
    const a = find(clubs, m.away);
    if (h && a) return { hLg: lg, aLg: lg, h, a, same: true };
  }
  const hit = async (name) => {
    for (const lg of [...DOMESTIC, ...EURO]) {
      const c = find(await clubsOf(lg), name);
      if (c) return { lg, club: c };
    }
    return null;
  };
  const h = await hit(m.home);
  const a = await hit(m.away);
  return h && a ? { hLg: h.lg, aLg: a.lg, h: h.club, a: a.club, same: h.lg === a.lg } : null;
}

const tables = new Map();
function tableOf(lg) {
  if (!tables.has(lg)) {
    tables.set(lg, get("/soccerstandings", { league: lg }, 21600)
      .then((rows) => {
        const map = new Map();
        let goals = 0;
        let games = 0;
        for (const r of rows) {
          const gp = Number(r.games_played) || 0;
          map.set(r.team?.team_id, { pos: Number(r.league_rank ?? r.group_rank) || undefined, size: rows.length, pts: Number(r.points) || 0, gp });
          goals += Number(r.goals_for) || 0;
          games += gp;
        }
        return { map, lgAvg: games >= 40 ? goals / games : null };
      })
      .catch(() => ({ map: new Map(), lgAvg: null })));
  }
  return tables.get(lg);
}

// A team's finished matches this season in one competition: its domestic league, or the UEFA competition for clubs
// with no domestic data. Other competitions are left out so season rates match the table used.
// Uses only documented parameters (league, team, status). offset is sent only for a second page.
async function results(id, dom) {
  const fetchAll = async (base) => {
    const first = await get("/soccermatches", base, 43200);
    if (first.length < 50) return first;
    return [...first, ...(await get("/soccermatches", { ...base, offset: 50 }, 43200))];
  };
  let rows = [];
  let err = null;
  for (const base of [{ league: dom, team: id, status: "final" }, { team: id, status: "final" }]) {
    try { rows = await fetchAll(base); err = null; break; } catch (e) { err = e; }
  }
  if (err) throw err;
  return rows
    .filter((r) => r.status === "final" && r.league === dom && Number.isFinite(Number(r.home_score)) && Number.isFinite(Number(r.away_score)))
    .map((r) => {
      const home = r.home_team?.team_id === id;
      const hs = Number(r.home_score);
      const as = Number(r.away_score);
      return { date: r.start_time || r.date || "", gf: home ? hs : as, ga: home ? as : hs, home, oppId: home ? r.away_team?.team_id : r.home_team?.team_id };
    })
    .sort((x, y) => x.date.localeCompare(y.date));
}

export async function enrichNinjas(matches, limit = matches.length) {
  let count = 0;
  let warning = "";
  for (let i = 0; i < matches.length && count < limit; i += 2) {
    await Promise.all(matches.slice(i, i + 2).map(async (m) => {
      try {
        const hit = await locate(m);
        if (!hit) return;
        const [hr, ar, ht, at] = await Promise.all([
          results(hit.h.team_id, hit.hLg), results(hit.a.team_id, hit.aLg), tableOf(hit.hLg), tableOf(hit.aLg),
        ]);
        if (!hr.length && !ar.length) return;
        applyStats(m, {
          same: hit.same, hr, ar, aId: hit.a.team_id, lgAvg: ht.lgAvg, source: "api-ninjas",
          hRow: ht.map.get(hit.h.team_id), aRow: at.map.get(hit.a.team_id),
        });
        count++;
      } catch (e) {
        warning ||= e.message;
      }
    }));
  }
  return { count, warning };
}