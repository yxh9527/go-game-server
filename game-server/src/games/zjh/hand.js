import { cardName, rankValue } from "../holdem/cards.js";

function isStraight3(values) {
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  if (uniq.length !== 3) {
    return false;
  }
  if (uniq[2] - uniq[0] === 2 && uniq[1] - uniq[0] === 1) {
    return true;
  }
  return uniq[0] === 2 && uniq[1] === 3 && uniq[2] === 14;
}

export function evaluate3(ids) {
  if (!Array.isArray(ids) || ids.length !== 3 || new Set(ids).size !== 3
    || !ids.every((id) => Number.isInteger(id) && id >= 0 && id < 52)) throw new Error("Invalid three-card hand");
  const cards = ids.map((id) => ({ id, value: rankValue(id), suit: Math.floor(id / 13) }));
  const values = cards.map((c) => c.value).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const straight = isStraight3(values);
  const counts = new Map();
  for (const v of values) {
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pack = (cardTypeId, name, key) => ({
    cardTypeId,
    name,
    key,
    pokerEnumList: ids.map(cardName),
    handCardList: ids,
  });
  if (groups[0][1] === 3) {
    return pack(6, "BAOZI", [groups[0][0]]);
  }
  if (flush && straight) {
    return pack(5, "STRAIGHT_FLUSH", values[0] === 14 && values[2] === 2 ? [3] : [values[0]]);
  }
  if (flush) {
    return pack(4, "FLUSH", values);
  }
  if (straight) {
    return pack(3, "STRAIGHT", values[0] === 14 && values[2] === 2 ? [3] : [values[0]]);
  }
  if (groups[0][1] === 2) {
    return pack(2, "PAIR", [groups[0][0], groups[1][0]]);
  }
  return pack(1, "HIGH", values);
}

export function compare3(a, b) {
  if (a.cardTypeId !== b.cardTypeId) {
    return a.cardTypeId - b.cardTypeId;
  }
  const n = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < n; i += 1) {
    const dv = (a.key[i] || 0) - (b.key[i] || 0);
    if (dv) {
      return dv;
    }
  }
  return 0;
}

// Room compareRule=1: equal ranks are resolved by suit, spade > heart > club > diamond.
// For pairs compare the pair first; for A23 compare the three before the ace.
export function compareWithSuit(a, b) {
  const rank = compare3(a, b);
  if (rank) return rank;
  const ordered = (hand) => hand.handCardList.slice().sort((x, y) => {
    const score = (card) => {
      let value = rankValue(card);
      if ([3, 5].includes(hand.cardTypeId) && hand.key[0] === 3 && value === 14) value = 1;
      if (hand.cardTypeId === 2 && value === hand.key[0]) value += 20;
      return value * 4 + Math.floor(card / 13);
    };
    return score(y) - score(x);
  });
  const ac = ordered(a), bc = ordered(b);
  for (let i = 0; i < 3; i += 1) {
    const suit = Math.floor(ac[i] / 13) - Math.floor(bc[i] / 13);
    if (suit) return suit;
  }
  return 0;
}
