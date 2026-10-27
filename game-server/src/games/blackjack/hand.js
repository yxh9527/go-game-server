// Client cards use suit * 13 + rank (A=0, K=12). Six packs, no jokers.
export const cardValue = card => Math.min(card % 13 + 1, 10);
export const makeShoe = () => Array.from({ length: 312 }, (_, i) => i % 52);
export function evaluate(cards, splitHand = false) {
  if (!cards.length) return { pointValue: 0, pointValues: [], handType: 0, soft: false };
  const low = cards.reduce((n, c) => n + cardValue(c), 0);
  const soft = cards.some(c => c % 13 === 0) && low + 10 <= 21;
  const pointValue = soft ? low + 10 : low;
  const pointValues = soft ? [low, pointValue] : [pointValue];
  const handType = pointValue > 21 ? 1 : cards.length >= 5 ? 4
    : cards.length === 2 && pointValue === 21 && !splitHand ? 5 : pointValue === 21 ? 3 : 2;
  return { pointValue, pointValues, handType, soft };
}
export function compare(player, dealer) {
  if (player.handType === 1) return -1; // Both bust: dealer wins.
  if (dealer.handType === 1) return 1;
  const priority = h => h.handType === 5 ? 3 : h.handType === 4 ? 2 : 1;
  const difference = priority(player) - priority(dealer);
  if (difference) return Math.sign(difference);
  if (priority(player) > 1) return 0;
  return Math.sign(player.pointValue - dealer.pointValue);
}
export function profit(hand, dealer) {
  const evaluation = evaluate(hand.cards, hand.splitHand);
  const outcome = compare(evaluation, evaluate(dealer));
  return outcome > 0 ? Math.floor(hand.betAmount * ([4, 5].includes(evaluation.handType) ? 3 : 2) / 2)
    : outcome < 0 ? -hand.betAmount : 0;
}
