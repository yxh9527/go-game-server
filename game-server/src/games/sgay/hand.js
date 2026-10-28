// 0..12 diamonds A..K, then clubs, hearts, spades: original client encoding.
export const rank = card => card % 13 + 1;
export function evaluate(cards) {
  if (!Array.isArray(cards) || cards.length !== 3 || new Set(cards).size !== 3
      || cards.some(c => !Number.isInteger(c) || c < 0 || c >= 52)) throw new Error('Invalid Sgay hand');
  const ranks = cards.map(rank), faces = ranks.filter(r => r >= 11).length;
  const points = ranks.reduce((n, r) => n + Math.min(r, 10), 0) % 10;
  const triple = ranks.every(r => r === ranks[0]);
  const cardTypeId = triple ? ranks[0] === 3 ? 33 : 32 : faces === 3 ? 31 : points * 3 + faces + 1;
  const top = cards.slice().sort((a, b) => rank(b) - rank(a) || b - a)[0];
  return { cardTypeId, points, faces, triple, topRank: rank(top), topSuit: Math.floor(top / 13) };
}
export function compareHands(a, b) {
  return a.cardTypeId - b.cardTypeId || a.topRank - b.topRank || a.topSuit - b.topSuit;
}
export function cardTypeInfo(cards) {
  return { handCardList: cards.slice(), cardTypeId: evaluate(cards).cardTypeId,
    pokerEnumList: cards.map(c => ['DIAMOND', 'CLUB', 'HEART', 'SPADE'][Math.floor(c / 13)] + '_'
      + (['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][rank(c)])) };
}
