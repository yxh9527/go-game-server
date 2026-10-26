// Contribution layers keep a short all-in eligible only for its matched pot.
// Folded contributions remain in the pot. Uncalled excess returns to its owner.
export function buildPots(players) {
  const levels = [...new Set(players.map((p) => p.totalBet).filter((n) => n > 0))].sort((a, b) => a - b);
  let previous = 0;
  return levels.map((level) => {
    const contributors = players.filter((p) => p.totalBet >= level);
    const pot = { amount: (level - previous) * contributors.length, contributors,
      eligible: contributors.filter((p) => !p.folded) };
    previous = level;
    return pot;
  });
}

export function awardPots(players, ranked, bankerId, compareRank) {
  const payout = new Map(players.map((p) => [p.uid, 0]));
  const winners = new Set();
  const pots = buildPots(players);
  const positions = players.slice().sort((a, b) => a.pos - b.pos);
  const dealer = positions.findIndex((p) => p.uid === bankerId);
  const clockwise = [...positions.slice(dealer + 1), ...positions.slice(0, dealer + 1)];
  for (const pot of pots) {
    if (pot.contributors.length === 1 && !pot.contributors[0].folded) {
      const uid = pot.contributors[0].uid;
      payout.set(uid, payout.get(uid) + pot.amount);
      continue;
    }
    const eligibleIds = new Set(pot.eligible.map((p) => p.uid));
    const eligible = ranked.filter((r) => eligibleIds.has(r.member.uid));
    // A voluntarily folded higher contribution is dead money for live hands.
    const candidates = eligible.length ? eligible : ranked;
    const best = candidates.filter((r) => compareRank(r.eval, candidates[0].eval) === 0);
    const winningIds = new Set(best.map((r) => r.member.uid));
    const ordered = clockwise.filter((p) => winningIds.has(p.uid));
    const share = Math.floor(pot.amount / ordered.length);
    const odd = pot.amount % ordered.length;
    ordered.forEach((p, index) => {
      payout.set(p.uid, payout.get(p.uid) + share + (index < odd ? 1 : 0));
      winners.add(p.uid);
    });
  }
  return { payout, winners, pots };
}
