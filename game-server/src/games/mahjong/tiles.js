import { randomInt } from 'node:crypto';

// Original clients: 0..8 tong, 9..17 tiao, 18..26 wan; hzxl 27 = joker.
// Jsmj 27..29 = zhong/fa/bai, 30 = GO flower.
export const suit = card => card >= 18 && card <= 26 ? 1 : card >= 0 && card <= 8 ? 2 : card >= 9 && card <= 17 ? 3 : 4;
export const rank = card => card < 27 ? card % 9 + 1 : 10;
export const counts = cards => cards.reduce((a, c) => { a[c]++; return a; }, Array(31).fill(0));
export const sortTiles = cards => cards.sort((a, b) => a - b);
export function deckFor(rules) {
  const types = rules.family === 'jsmj' ? Array.from({ length: rules.maxPeople === 2 ? 12 : 30 }, (_, i) => i + (rules.maxPeople === 2 ? 18 : 0))
    : Array.from({ length: rules.family === 'hzxl' ? 28 : 27 }, (_, i) => i);
  return types.flatMap(c => Array(rules.family === 'hzxl' && c === 27 ? 8 : 4).fill(c))
    .concat(rules.family === 'jsmj' ? [30, 30, 30, 30] : []);
}
export function shuffled(cards) {
  const out = cards.slice();
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
export function validDeck(deck, rules) {
  if (!Array.isArray(deck)) return false;
  const expected = counts(deckFor(rules)), actual = counts([]);
  for (const c of deck) { if (!Number.isInteger(c) || c < 0 || c > 30 || ++actual[c] > expected[c]) return false; }
  return actual.every((n, i) => n === expected[i]);
}
export function contains(cards, wanted) {
  const available = counts(cards);
  return wanted.every(c => Number.isInteger(c) && c >= 0 && c <= 30 && available[c]-- > 0);
}
