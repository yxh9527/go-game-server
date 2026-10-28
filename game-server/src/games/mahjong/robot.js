import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { counts, suit, rank } = await rel(import.meta.url, './tiles.js', v);

export const thinkTime = (rng = Math.random) => 700 + Math.floor(rng() * 1500);
export function chooseQue(cards) {
  return [1, 2, 3].sort((a, b) => cards.filter(c => suit(c) === a).length - cards.filter(c => suit(c) === b).length || a - b)[0];
}
export function chooseExchange(cards) {
  const same = [1, 2, 3].map(s => cards.filter(c => suit(c) === s)).filter(a => a.length >= 3).sort((a, b) => a.length - b.length);
  return same[0]?.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 3) || [];
}
// Input deliberately contains only this player's tiles and public discards.
export function chooseAction({ cards, options, queType = 0, ting = false, drawn, family, publicCards = [] }, rng = Math.random) {
  const preferred = [8, 10, 11, 4, 5, 6, 16, 3, 12, 9, 1];
  for (const type of preferred) {
    const op = options.find(o => o.type === type);
    if (op) return { ...op, ...(type === 12 ? { chiUseCards: op.cards[0] } : {}) };
  }
  if (options.some(o => o.type === 7) && !options.some(o => o.type === 2)) return { type: 7 };
  if (ting && drawn != null && cards.includes(drawn)) return { type: 2, card: drawn };
  const c = counts(cards), visible = counts(publicCards), missingSuit = cards.filter(c => suit(c) === queType);
  const allowed = missingSuit.length ? missingSuit : cards;
  const ranked = [...new Set(allowed)].map(t => {
    let keep = (c[t] - 1) * 3.5;
    if (family === 'hzxl' && t === 27) keep += 15;
    if (t < 27) for (const delta of [-2, -1, 1, 2]) {
      const other = t + delta;
      if (other >= 0 && other < 27 && suit(other) === suit(t)) keep += c[other] * (Math.abs(delta) === 1 ? 1.3 : .6);
    }
    keep -= visible[t] * .25;
    return { card: t, keep: keep + rng() * .5 };
  }).sort((a, b) => a.keep - b.keep || a.card - b.card);
  return { type: 2, card: ranked[0]?.card };
}
