const BLEND = 0.5; // weight of the model estimate against the no-vig market probability

// Average several models' probabilities for the same outcome.
function merge(list) {
  const acc = {};
  for (const preds of list) {
    for (const [id, pr] of Object.entries(preds)) {
      const o = (acc[id] ??= { sum: {}, n: {}, reason: pr.reason });
      for (const [k, v] of Object.entries(pr.p || {})) {
        const x = Number(v);
        if (x > 0) { o.sum[k] = (o.sum[k] || 0) + x; o.n[k] = (o.n[k] || 0) + 1; }
      }
    }
  }
  return Object.fromEntries(Object.entries(acc).map(([id, o]) => [
    id, { reason: o.reason, p: Object.fromEntries(Object.keys(o.sum).map((k) => [k, o.sum[k] / o.n[k]])) },
  ]));
}

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

export function buildSlips(matches, predsList, kinds, targets, unique = true) {
  const preds = merge(predsList);
  const used = new Set();
  return targets.map((target) => {
    const minOdds = 1.05 + 0.2 * Math.log10(target); // bigger targets allow slightly longer legs
    const pool = matches
      .filter((m) => preds[m.id] && !used.has(m.id))
      .map((m) => bestPick(m, preds[m.id], kinds, minOdds))
      .filter(Boolean)
      .sort((a, b) => b.eff - a.eff);
    let legs = [];
    let odds = 1;
    for (const p of pool) {
      if (odds >= target) break;
      legs.push(p);
      odds *= p.odds;
    }
    if (odds < target) return { target, legs: [], note: "Not enough matches in this window to reach these odds. Try a longer window or a lower target." };
    // Drop the weakest legs while the slip still clears the target.
    for (const p of [...legs].sort((a, b) => a.eff - b.eff)) {
      if (odds / p.odds >= target) {
        legs = legs.filter((l) => l !== p);
        odds /= p.odds;
      }
    }
    if (unique) legs.forEach((l) => used.add(l.matchId));
    const prob = legs.reduce((a, l) => a * l.prob, 1);
    return { target, legs, odds, prob, expected: prob * odds };
  });
}
