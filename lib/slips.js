const TIERS = [10, 50, 100]; // built in this order, each match used once across tiers
const MIN_LEG = { 10: 1.2, 50: 1.4, 100: 1.6 }; // keeps big slips from needing 25 tiny legs
const BLEND = 0.5; // weight of the model estimate against the no-vig market probability

// One leg per match: the outcome, across all markets, with the most odds gained per unit of probability given up.
function bestPick(m, pred, kinds, minOdds) {
  let best = null;
  for (const mk of m.markets) {
    if (kinds && !kinds.includes(mk.kind)) continue;
    const vals = mk.outcomes.map((o) => {
      const v = Number(pred.p?.[`${mk.mid}:${o.oid}`]);
      return v > 0 ? v : o.fair;
    });
    const sum = vals.reduce((a, b) => a + b, 0);
    mk.outcomes.forEach((o, i) => {
      const prob = BLEND * (vals[i] / sum) + (1 - BLEND) * o.fair;
      if (o.odds < minOdds || prob < 0.2) return;
      const eff = Math.log(o.odds) / -Math.log(prob);
      if (!best || eff > best.eff) {
        best = {
          matchId: m.id, match: `${m.home} v ${m.away}`, league: m.league, start: m.start,
          label: o.label, odds: o.odds, prob, eff, reason: pred.reason || "",
        };
      }
    });
  }
  return best;
}

export function buildSlips(matches, preds, kinds) {
  const used = new Set();
  return TIERS.map((target) => {
    const pool = matches
      .filter((m) => preds[m.id] && !used.has(m.id))
      .map((m) => bestPick(m, preds[m.id], kinds, MIN_LEG[target]))
      .filter(Boolean)
      .sort((a, b) => b.eff - a.eff);
    let legs = [];
    let odds = 1;
    for (const p of pool) {
      if (odds >= target) break;
      legs.push(p);
      odds *= p.odds;
    }
    if (odds < target) return { target, legs: [], note: "Not enough matches to reach these odds." };
    // Drop the weakest legs while the slip still clears the target.
    for (const p of [...legs].sort((a, b) => a.eff - b.eff)) {
      if (odds / p.odds >= target) {
        legs = legs.filter((l) => l !== p);
        odds /= p.odds;
      }
    }
    legs.forEach((l) => used.add(l.matchId));
    const prob = legs.reduce((a, l) => a * l.prob, 1);
    return { target, legs, odds, prob, expected: prob * odds };
  });
}
