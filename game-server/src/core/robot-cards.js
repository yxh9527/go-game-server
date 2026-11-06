// Bounded independent-card sampling. Inputs are explicit information
// projections; this module never receives an engine deck or future cards.
const cache = new WeakMap();
export function humanCards(players, uid, field = 'hole') {
  return players.filter(p => p.uid !== uid).map(p => ({ uid: p.uid,
    cards: p.bot ? null : Array.isArray(p[field]) ? p[field].slice() : null }));
}
export function sampleDeals({ hand, uid, visible, opponents, size, deckSize = 52, samples = 48 }) {
  if (!Array.isArray(visible) || visible.length > size || new Set(visible).size !== visible.length
    || visible.some(c => !Number.isInteger(c) || c < 0 || c >= deckSize)) return [];
  const known = new Set(visible);
  const holdings = opponents.map(p => {
    const cards = p.cards;
    if (!Array.isArray(cards) || cards.length !== size || new Set(cards).size !== size
      || cards.some(c => !Number.isInteger(c) || c < 0 || c >= deckSize || known.has(c))) return null;
    cards.forEach(c => known.add(c)); return cards.slice();
  });
  const key = JSON.stringify([uid, visible, opponents.map((p, i) => [p.uid, holdings[i]]), size, deckSize, samples]);
  let estimates = hand && cache.get(hand);
  if (hand && !estimates) cache.set(hand, estimates = new Map());
  if (estimates?.get(uid)?.key === key) return estimates.get(uid).value;
  const pool = Array.from({ length: deckSize }, (_, i) => i).filter(c => !known.has(c));
  if (pool.length < size - visible.length + holdings.filter(h => !h).length * size) return [];
  let seed = 2166136261;
  for (const c of key) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const exact = visible.length === size && holdings.every(Boolean);
  const value = Array.from({ length: exact ? 1 : Math.min(64, samples) }, () => {
    const deck = pool.slice(); let at = 0;
    const draw = () => {
      const i = at + Math.floor(random() * (deck.length - at));
      [deck[at], deck[i]] = [deck[i], deck[at]]; return deck[at++];
    };
    const own = visible.slice(); while (own.length < size) own.push(draw());
    return { own, rivals: holdings.map(cards => cards || Array.from({ length: size }, draw)) };
  });
  estimates?.set(uid, { key, value }); return value;
}
