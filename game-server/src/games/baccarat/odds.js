// Enumerate rank/value counts, never future shoe order. First-card baccarat
// exposes one card on each side; all unexposed cards remain unknown to pricing.
const value = rank => rank >= 9 ? 0 : rank + 1;
const tiers = [0, 1, 1, 1, 1, 1, 2, 2, 3, 1];

export function outcomeProbabilities(shoe, exposed = null) {
  const counts = Array(13).fill(0);
  for (const card of shoe) counts[card % 13]++;
  const fixed = exposed ? { 0: exposed.other % 13, 2: exposed.banker % 13 } : {};
  let remaining = shoe.length;
  for (const rank of Object.values(fixed)) {
    if (!counts[rank]) throw new Error('Exposed baccarat card is not in the shoe');
    counts[rank]--; remaining--;
  }
  const probabilities = Array.from({ length: 10 }, (_, id) => Array(tiers[id]).fill(0));
  const ranks = [];
  function finish(p, b, pn, bn, probability) {
    const winner = p > b ? 1 : b > p ? 2 : 3;
    probabilities[winner][0] += probability;
    if (ranks[0] === ranks[1]) probabilities[4][0] += probability;
    if (ranks[2] === ranks[3]) probabilities[5][0] += probability;
    if (b === 6 && b > p) probabilities[6][bn - 2] += probability;
    if (p === 7 && p > b) probabilities[7][pn - 2] += probability;
    if (p === 7 && b === 6) probabilities[8][pn + bn - 4] += probability;
    if (p !== b) probabilities[9][0] += probability;
  }
  function drawFour(probability, n) {
    const p = (value(ranks[0]) + value(ranks[1])) % 10;
    const b = (value(ranks[2]) + value(ranks[3])) % 10;
    if (p >= 8 || b >= 8) { finish(p, b, 2, 2, probability); return; }
    const values = Array(10).fill(0);
    for (let rank = 0; rank < 13; rank++) values[value(rank)] += counts[rank];
    function banker(pFinal, third, probability, n) {
      const take = third === null ? b <= 5 : b <= 2 || b === 3 && third !== 8
        || b === 4 && third >= 2 && third <= 7 || b === 5 && third >= 4 && third <= 7
        || b === 6 && (third === 6 || third === 7);
      if (!take) { finish(pFinal, b, third === null ? 2 : 3, 2, probability); return; }
      for (let v = 0; v < 10; v++) if (values[v]) {
        finish(pFinal, (b + v) % 10, third === null ? 2 : 3, 3, probability * values[v] / n);
      }
    }
    if (p > 5) banker(p, null, probability, n);
    else for (let v = 0; v < 10; v++) if (values[v]) {
      const chance = values[v] / n; values[v]--;
      banker((p + v) % 10, v, probability * chance, n - 1); values[v]++;
    }
  }
  function choose(slot, probability, n) {
    if (slot === 4) { drawFour(probability, n); return; }
    if (fixed[slot] !== undefined) { ranks[slot] = fixed[slot]; choose(slot + 1, probability, n); return; }
    for (let rank = 0; rank < 13; rank++) if (counts[rank]) {
      const chance = counts[rank] / n; counts[rank]--; ranks[slot] = rank;
      choose(slot + 1, probability * chance, n - 1); counts[rank]++;
    }
  }
  choose(0, 1, remaining);
  return probabilities;
}

const baseProbabilities = new Map();
export function configuredOdds(config) {
  return Object.fromEntries(Object.keys(config.odds).map(Number).map(id => [id,
    { id, oddsList: (config.sideOdds?.[id] || [config.odds[id]]).map(n => Math.round(n * 100)) }]));
}

export function brightOdds(shoe, exposed, config) {
  const decks = config.decks || 8;
  if (!baseProbabilities.has(decks)) baseProbabilities.set(decks,
    outcomeProbabilities(Array.from({ length: decks * 52 }, (_, i) => i % 52)));
  const base = baseProbabilities.get(decks), conditional = outcomeProbabilities(shoe, exposed);
  const odds = configuredOdds(config);
  for (let id = 1; id <= 9; id++) {
    odds[id].oddsList = odds[id].oddsList.map((price, tier) => {
      if (!conditional[id][tier]) return 0;
      // Preserve the published game's expected return for each payout tier;
      // main bets additionally return their stake on ties. Units are 1/100.
      const baseReturn = base[id][tier] * (1 + price / 100) + (id <= 2 ? base[3][0] : 0);
      const returnOnWin = baseReturn - (id <= 2 ? conditional[3][0] : 0);
      return Math.max(0, Math.floor((returnOnWin / conditional[id][tier] - 1) * 100 + 1e-9));
    });
  }
  return odds;
}
