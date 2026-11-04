// Football-only statistical model. Turns season goals, recent form, home and away records, points per game
// and web team news into expected goals for each side, then into probabilities for every market we load.
const HOME_ADV = 1.1; // home sides score about 10% more, away about 10% less (used for the all-games rates)
const SHRINK = 6; // pseudo-games of league average mixed into every rate (stops tiny samples from looking extreme)
const TILT = 0.06; // how strongly the points-per-game gap (table quality) nudges expected goals
const VENUE_W = 0.35; // weight of home-only / away-only rates against all-games rates
const RHO = -0.1; // Dixon-Coles: real football has more 0-0 and 1-1 and fewer 1-0 and 0-1 than two independent Poissons
const NEWS_TILT = 0.05; // per point of team-news sentiment (-2 to +2), scaled by the researcher's confidence
const FALLBACK_AVG = 1.35; // goals per team per game when the league average is unknown
const MAXG = 10;

const shrink = (sum, n, lg) => (sum + SHRINK * lg) / (n + SHRINK);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function pois(l) {
  const p = [Math.exp(-l)];
  for (let i = 1; i <= MAXG; i++) p.push((p[i - 1] * l) / i);
  return p;
}

// Season rate blended with the last five games (75/25).
const rate = (sSum, sN, rSum, rN, lg) => 0.75 * shrink(sSum, sN, lg) + 0.25 * shrink(rSum, rN, lg);

// "1", "X", "2" for Full Time Result and "1X", "X2", "12" for Double Chance. null for every other market.
export function resultType(mk, o) {
  if (mk.kind !== "result") return null;
  const n = String(o.n ?? "");
  if (/Double Chance/i.test(mk.name)) {
    const has1 = /1/.test(n) || /home/i.test(n);
    const hasX = /x/i.test(n) || /draw/i.test(n);
    const has2 = /2/.test(n) || /away/i.test(n);
    if (has1 && hasX && !has2) return "1X";
    if (hasX && has2 && !has1) return "X2";
    if (has1 && has2 && !hasX) return "12";
    return null;
  }
  if (/Full Time Result/i.test(mk.name)) return n === "1" ? "1" : n === "2" ? "2" : /^x$/i.test(n) ? "X" : null;
  return null;
}

export function statsModel(m) {
  const s = m.stats;
  if (!s?.home || !s?.away) return null;
  const { home: h, away: a } = s;
  if (h.gp < 5 || a.gp < 5) return null;
  const L = s.lgAvg || FALLBACK_AVG;

  // Expected goals from all games, with a flat home advantage.
  const attH = rate(h.gf, h.gp, h.rf, h.rn, L);
  const defH = rate(h.ga, h.gp, h.ra, h.rn, L);
  const attA = rate(a.gf, a.gp, a.rf, a.rn, L);
  const defA = rate(a.ga, a.gp, a.ra, a.rn, L);
  let lh = ((attH * defA) / L) * HOME_ADV;
  let la = ((attA * defH) / L) / HOME_ADV;

  // Blend in what each side actually does at this venue (home games for the home side, away games for the away side).
  if ((h.vgp ?? 0) >= 4 && (a.vgp ?? 0) >= 4) {
    const lhV = (shrink(h.vgf, h.vgp, L) * shrink(a.vga, a.vgp, L)) / L;
    const laV = (shrink(a.vgf, a.vgp, L) * shrink(h.vga, h.vgp, L)) / L;
    lh = (1 - VENUE_W) * lh + VENUE_W * lhV;
    la = (1 - VENUE_W) * la + VENUE_W * laV;
  }

  // Table quality beyond goals.
  const tilt = Math.exp(TILT * clamp(h.ppg - a.ppg, -1.5, 1.5));
  lh *= tilt;
  la /= tilt;

  // Web team news: injuries, suspensions, rotation, motivation. Sentiment is -2 (weakened) to +2 (strengthened).
  const nw = m.news;
  if (nw) {
    const c = clamp(Number(nw.confidence) || 0, 0, 1);
    const d = NEWS_TILT * (clamp(Number(nw.home) || 0, -2, 2) - clamp(Number(nw.away) || 0, -2, 2)) * c;
    lh *= Math.exp(d);
    la *= Math.exp(-d);
  }

  const ph = pois(lh);
  const pa = pois(la);
  const tau = (i, j) => (i === 0 && j === 0 ? 1 - lh * la * RHO : i === 0 && j === 1 ? 1 + lh * RHO : i === 1 && j === 0 ? 1 + la * RHO : i === 1 && j === 1 ? 1 - RHO : 1);
  let home = 0, draw = 0, away = 0, btts = 0, mass = 0;
  const total = new Array(2 * MAXG + 1).fill(0);
  for (let i = 0; i <= MAXG; i++) {
    for (let j = 0; j <= MAXG; j++) {
      const p = ph[i] * pa[j] * tau(i, j);
      mass += p;
      total[i + j] += p;
      if (i > j) home += p; else if (i === j) draw += p; else away += p;
      if (i > 0 && j > 0) btts += p;
    }
  }
  home /= mass; draw /= mass; away /= mass; btts /= mass;
  const over = (line) => total.reduce((acc, p, g) => (g > line ? acc + p / mass : acc), 0);

  // More games and league fixtures mean more trust. Cups and European ties are noisier.
  const n = Math.min(h.gp, a.gp);
  let conf = n / (n + 8);
  if (s.kind !== "league") conf *= 0.6;

  function prob(mk, o) {
    const n = String(o.n ?? "");
    if (mk.kind === "totals") {
      if (!Number.isFinite(mk.handicap) || Number.isInteger(mk.handicap)) return null;
      const ov = over(mk.handicap);
      return /over/i.test(n) ? ov : /under/i.test(n) ? 1 - ov : null;
    }
    if (mk.kind === "btts") return /yes/i.test(n) ? btts : /no/i.test(n) ? 1 - btts : null;
    const t = resultType(mk, o);
    return t === "1" ? home : t === "2" ? away : t === "X" ? draw : t === "1X" ? home + draw : t === "X2" ? draw + away : t === "12" ? home + away : null;
  }

  return { conf, lh, la, home, draw, away, prob };
}