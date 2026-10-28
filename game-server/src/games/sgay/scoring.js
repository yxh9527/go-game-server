import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { compareHands } = await rel(import.meta.url, './hand.js', v);

// The strongest hand takes up to twice its own contribution, then the next
// hand takes from the remainder. This is not a Holdem side-pot or banker game.
export function payouts(players, ante, taxPercent = 0, maxTax = 0) {
  const order = players.slice().sort((a, b) => compareHands(b.result, a.result) || a.pos - b.pos);
  let pot = players.reduce((sum, p) => sum + p.bet, 0);
  const gross = new Map(players.map(p => [p.uid, 0]));
  for (const p of order) {
    const amount = Math.min(pot, 2 * p.bet);
    gross.set(p.uid, amount); pot -= amount;
  }
  if (pot !== 0) throw new Error('Unallocated Sgay pot');
  const balances = new Map(players.map(p => [p.uid, p.openingPoint - p.bet + gross.get(p.uid)]));
  const bonuses = new Map(players.map(p => [p.uid, 0]));
  for (const winner of order.filter(p => p.result.triple)) {
    for (const loser of order) {
      if (loser === winner) continue;
      const bonus = Math.min(ante, balances.get(loser.uid));
      balances.set(loser.uid, balances.get(loser.uid) - bonus);
      balances.set(winner.uid, balances.get(winner.uid) + bonus);
      bonuses.set(loser.uid, bonuses.get(loser.uid) - bonus);
      bonuses.set(winner.uid, bonuses.get(winner.uid) + bonus);
    }
  }
  return players.map(p => {
    const beforeTax = balances.get(p.uid) - p.openingPoint;
    const computedTax = Math.floor(Math.max(0, beforeTax) * taxPercent / 10000);
    const tax = maxTax > 0 ? Math.min(maxTax, computedTax) : computedTax;
    return { uid: p.uid, gross: gross.get(p.uid), bonus: bonuses.get(p.uid), tax,
      score: beforeTax - tax, point: balances.get(p.uid) - tax };
  });
}
