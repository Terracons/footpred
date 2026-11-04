// Past performance from ESPN's public JSON endpoints. No key needed, but they are undocumented and may change.
const HOST = "https://site.api.espn.com/apis/site/v2/sports";
const HOST_V2 = "https://site.api.espn.com/apis/v2/sports"; // standings live under v2
const LEAGUES = {
  football: ["eng.1", "eng.2", "esp.1", "ita.1", "ger.1", "fra.1", "ned.1", "por.1", "sco.1", "usa.1", "bra.1", "arg.1", "mex.1", "jpn.1", "kor.1", "aus.1", "tur.1", "bel.1", "uefa.champions", "uefa.europa", "afc.champions"].map((l) => `soccer/${l}`),
  basketball: ["basketball/nba"],
  hockey: ["hockey/nhl"],
  baseball: ["baseball/mlb"],
};
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

async function get(path, revalidate, host = HOST) {
  const res = await fetch(`${host}/${path}`, { next: { revalidate } });
  if (!res.ok) throw new Error(`ESPN ${path} failed with status ${res.status}`);
  return res.json();
}

const teamLists = new Map();
function teamsOf(lg) {
  if (!teamLists.has(lg)) {
    teamLists.set(lg, get(`${lg}/teams`, 86400)
      .then((j) => (j.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean))
      .catch(() => []));
  }
  return teamLists.get(lg);
}

// League table: position, points, games played, plus the league's goals per team per game.
const tables = new Map();
function tableOf(lg) {
  if (!tables.has(lg)) {
    tables.set(lg, get(`${lg}/standings`, 21600, HOST_V2)
      .then((j) => {
        const groups = j.children?.length ? j.children.map((c) => c.standings?.entries || []) : [j.standings?.entries || []];
        const map = new Map();
        let goals = 0;
        let games = 0;
        for (const entries of groups) {
          entries.forEach((e, i) => {
            const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s.value]));
            const gp = Number(st.gamesPlayed) || 0;
            map.set(String(e.team?.id), { pos: Number(st.rank) || i + 1, size: entries.length, pts: Number(st.points) || 0, gp });
            goals += Number(st.pointsFor) || 0;
            games += gp;
          });
        }
        return { map, lgAvg: games >= 40 ? goals / games : null };
      })
      .catch(() => ({ map: new Map(), lgAvg: null })));
  }
  return tables.get(lg);
}

function find(teams, name) {
  const n = norm(name);
  const names = (t) => [t.displayName, t.name, t.shortDisplayName].filter(Boolean).map(norm);
  return teams.find((t) => names(t).includes(n))
    || teams.find((t) => n.length >= 5 && names(t).some((x) => x.length >= 5 && (x.includes(n) || n.includes(x))));
}

// Finds each team's domestic league. For European ties the two teams sit in different leagues,
// so their form and table position come from their own league.
async function locate(m, sport) {
  const all = LEAGUES[sport] || [];
  const dom = sport === "football" ? all.filter((l) => !/uefa|afc\./.test(l)) : all;
  for (const lg of dom) {
    const teams = await teamsOf(lg);
    const h = find(teams, m.home);
    const a = find(teams, m.away);
    if (h && a) return { hLg: lg, aLg: lg, h, a, same: true };
  }
  const hit = async (name) => {
    for (const lg of dom) {
      const t = find(await teamsOf(lg), name);
      if (t) return { lg, team: t };
    }
    return null;
  };
  const h = await hit(m.home);
  const a = await hit(m.away);
  return h && a ? { hLg: h.lg, aLg: a.lg, h: h.team, a: a.team, same: false } : null;
}

// league, cup or european: decides how much the numbers are trusted.
function kindOf(m, same) {
  const l = String(m.league || "");
  if (/champions|europa|conference|libertadores|sudamericana/i.test(l)) return "european";
  if (/cup|copa|coppa|pokal|taça|taca|trophy|shield|play-?off|qualif|friendl/i.test(l)) return "cup";
  return same ? "league" : "cup";
}

const score = (c) => {
  const s = c?.score;
  return Number(typeof s === "object" && s !== null ? (s.value ?? s.displayValue) : s);
};

async function results(lg, id) {
  const j = await get(`${lg}/teams/${id}/schedule`, 43200);
  const out = [];
  for (const e of j.events || []) {
    const c = e.competitions?.[0];
    const done = c?.status?.type?.completed ?? e.status?.type?.completed;
    if (!c || !done) continue;
    const me = c.competitors?.find((x) => String(x.team?.id ?? x.id) === String(id));
    const op = c.competitors?.find((x) => x !== me);
    const gf = score(me);
    const ga = score(op);
    if (!me || !op || !Number.isFinite(gf) || !Number.isFinite(ga)) continue;
    out.push({ date: e.date || c.date || "", gf, ga, home: me.homeAway === "home", oppId: String(op.team?.id ?? op.id) });
  }
  return out.sort((x, y) => x.date.localeCompare(y.date));
}

const letters = (rs) => rs.map((r) => (r.gf > r.ga ? "W" : r.gf < r.ga ? "L" : "D")).join("");
const sum = (rs, k) => rs.reduce((a, r) => a + r[k], 0);

// Numbers for one side: season totals, last five, form at this venue, table row.
function side(rs, atHome, row) {
  const last = rs.slice(-5);
  const atVenue = rs.filter((r) => r.home === atHome);
  const venue = atVenue.slice(-5);
  const pts = rs.reduce((a, r) => a + (r.gf > r.ga ? 3 : r.gf === r.ga ? 1 : 0), 0);
  return {
    gp: rs.length, gf: sum(rs, "gf"), ga: sum(rs, "ga"),
    rf: sum(last, "gf"), ra: sum(last, "ga"), rn: last.length,
    ppg: rs.length ? pts / rs.length : 0,
    form: letters(last), venueForm: letters(venue), venueN: venue.length,
    vgp: atVenue.length, vgf: sum(atVenue, "gf"), vga: sum(atVenue, "ga"), // whole season at this venue (home games for the home side, away games for the away side)
    pos: row?.pos, size: row?.size, pts: row?.pts, tgp: row?.gp,
  };
}

function text(name, s, where) {
  if (!s.gp) return `${name}: no completed games found.`;
  const table = s.pos ? `position ${s.pos} of ${s.size} with ${s.pts} pts from ${s.tgp} games` : "table position unknown";
  const avg = (v, n) => (v / n).toFixed(2);
  return `${name}: ${table}; season avg scored ${avg(s.gf, s.gp)}, conceded ${avg(s.ga, s.gp)} (${s.gp} games, ${s.ppg.toFixed(2)} pts per game); ` +
    `last 5 ${s.form} (avg scored ${avg(s.rf, s.rn)}, conceded ${avg(s.ra, s.rn)}); last 5 ${where} ${s.venueForm || "n/a"}.`;
}

// Builds m.stats (numbers for the model) and m.context (text for the AI) from results and table rows.
// Shared by every data source, so ESPN and the fallback produce identical output.
export function applyStats(m, { sport = "football", same, hr, ar, hRow, aRow, lgAvg, aId, source }) {
  const kind = kindOf(m, same);
  const hs = side(hr, true, hRow);
  const as = side(ar, false, aRow);
  const meet = same ? hr.filter((r) => r.oppId === String(aId)).slice(-3).map((r) => `${r.gf}-${r.ga}`) : [];
  if (sport === "football") m.stats = { kind, lgAvg, home: hs, away: as, source };
  const note = kind === "league" ? "league match" : kind === "european"
    ? "European tie, form and table position are from each team's domestic league, rotation and travel can matter"
    : "cup or one-off fixture, more variance and possible rotation";
  m.context = [
    `Match type: ${note}.`,
    text(`${m.home} (home)`, hs, "at home"),
    text(`${m.away} (away)`, as, "away"),
    `Meetings this season from ${m.home} view: ${meet.join(", ") || "none"}.`,
  ].join(" ");
}

// Adds past performance, table position, match type and numeric stats to matches it can find.
// Stops after `limit` successes. Matches it cannot find are left untouched (no m.context) so a fallback can try them.
export async function enrichEspn(matches, limit = 12, sport = "football") {
  let count = 0;
  let warning = "";
  for (let i = 0; i < matches.length && count < limit; i += 3) {
    await Promise.all(matches.slice(i, i + 3).map(async (m) => {
      try {
        const hit = await locate(m, sport);
        if (!hit) return;
        const [hr, ar, ht, at] = await Promise.all([
          results(hit.hLg, hit.h.id), results(hit.aLg, hit.a.id), tableOf(hit.hLg), tableOf(hit.aLg),
        ]);
        if (!hr.length && !ar.length) return; // empty schedules: treat as not found
        applyStats(m, {
          sport, same: hit.same, hr, ar, aId: hit.a.id, lgAvg: ht.lgAvg, source: "espn",
          hRow: ht.map.get(String(hit.h.id)), aRow: at.map.get(String(hit.a.id)),
        });
        count++;
      } catch (e) {
        warning ||= e.message;
      }
    }));
  }
  return { count, warning };
}