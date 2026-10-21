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
