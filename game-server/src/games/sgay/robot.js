// Strategy sees only the two private cards already delivered to its owner.
// The hidden third card and opponent hands are never accepted as inputs.
export function chooseMultiple({ cards, maxMultiple, point, ante }, random = Math.random) {
  const visible = cards.filter(c => Number.isInteger(c) && c >= 0 && c < 52).slice(0, 2);
  const ranks = visible.map(c => c % 13 + 1);
  const pair = ranks.length === 2 && ranks[0] === ranks[1];
  const faces = ranks.filter(r => r >= 11).length;
  const cautious = point < ante * 20;
  const roll = random();
  let multiple = roll < 0.50 ? 1 : roll < 0.78 ? 2 : roll < 0.94 ? 3 : 5;
  if (!cautious && (pair || faces === 2) && random() < 0.5) multiple += 2;
  if (cautious) multiple = Math.min(multiple, 2);
  return Math.max(1, Math.min(maxMultiple, multiple));
}
export const thinkTime = (phase, random = Math.random) => phase === 'bet'
  ? 650 + Math.floor(random() * 2200) : 1400 + Math.floor(random() * 2500);
