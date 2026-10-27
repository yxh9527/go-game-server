import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { cardValue, evaluate } = await rel(import.meta.url, './hand.js', v);
export const thinkTime = () => 800 + Math.floor(Math.random() * 1800);
export function betAmount(point, ante, maxBet, rng = Math.random) {
  const units = rng() < .75 ? 1 : rng() < .8 ? 2 : 3;
  return Math.min(point, maxBet, ante * units);
}
// Inputs contain only this player's cards and the dealer's visible up-card.
export function choose(cards, upCard, actions) {
  const value = evaluate(cards), up = cardValue(upCard) === 1 ? 11 : cardValue(upCard);
  const has = action => actions.includes(action);
  if (has('SPLIT') && [1, 8].includes(cardValue(cards[0]))) return 'SPLIT';
  if (has('DOUBLE') && (!value.soft && (value.pointValue === 11 || value.pointValue === 10 && up <= 9
    || value.pointValue === 9 && up >= 3 && up <= 6) || value.soft && value.pointValue >= 16 && value.pointValue <= 18 && up >= 4 && up <= 6)) return 'DOUBLE';
  if (value.soft) return value.pointValue >= 19 || value.pointValue === 18 && up >= 2 && up <= 8 ? 'STAND' : 'HIT';
  return value.pointValue >= 17 || value.pointValue >= 13 && up >= 2 && up <= 6
    || value.pointValue === 12 && up >= 4 && up <= 6 ? 'STAND' : 'HIT';
}
