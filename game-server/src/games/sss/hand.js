// Rules: original SssConfig and zh_cn_Sss rule images in client 2.0.1279.
// Cards keep their original identities, including repeated 52/53 jokers.
export const TYPES = ['HIGH_CARD', 'ONE_PAIR', 'TWO_PAIR', 'THREE_OF_A_KIND', 'STRAIGHT',
  'FLUSH', 'FULL_HOUSE', 'FOUR_OF_A_KIND', 'STRAIGHT_FLUSH', 'FIVE_OF_A_KIND'];
const NAMES = ['高牌', '对子', '两对', '三条', '顺子', '同花', '葫芦', '铁支', '同花顺', '五同'];
const WATER = [{ 3: 3, 120: 20 }, { 6: 2, 7: 8, 8: 10, 9: 20 }, { 7: 4, 8: 5, 9: 10 }];
export const rank = c => c % 13 === 0 ? 14 : c % 13 + 1;
export const isJoker = c => c === 52 || c === 53;
export function deckFor(mode) {
  return [...Array.from({ length: 52 }, (_, c) => c).filter(c => c % 13 !== 1),
    ...Array.from({ length: mode === 1 ? 8 : 4 }, (_, i) => 52 + i % 2)];
}
export function compareKey(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}
function straightKey(ranks) {
  const r = [...new Set(ranks)].sort((a, b) => b - a);
  if (r.length !== ranks.length) return null;
  if (r.length === 5 && r.join(',') === '14,5,4,3,2') return [2, 5];
  if (r[0] - r.at(-1) === r.length - 1) return [r[0] === 14 ? 3 : 1, r[0]];
  return null;
}
function plain(ranks, flush) {
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const values = groups.map(g => g[0]);
  const sorted = ranks.slice().sort((a, b) => b - a);
  const straight = ranks.length === 5 ? straightKey(ranks) : null;
  let type = 0, key = sorted;
  if (groups[0][1] === 5) { type = 9; key = values; }
  else if (flush && straight) { type = 8; key = straight; }
  else if (groups[0][1] === 4) { type = 7; key = values; }
  else if (groups[0][1] === 3 && groups[1]?.[1] === 2) { type = 6; key = values; }
  // The original rule image orders triple flush > pair flush > high flush.
  else if (flush) { type = 5; key = [groups[0][1] >= 3 ? 2 : groups[0][1] === 2 ? 1 : 0, ...values]; }
  else if (straight) { type = 4; key = straight; }
  else if (groups[0][1] === 3) { type = 3; key = values; }
  else if (groups[0][1] === 2 && groups[1]?.[1] === 2) { type = 2; key = values; }
  else if (groups[0][1] === 2) { type = 1; key = values; }
  return { typeId: type, key: [type, ...key] };
}
const rankCard = (r, suit) => suit * 13 + (r === 14 ? 0 : r - 1);
export function evaluatePile(cards, position = 2, upper = null) {
  const real = cards.filter(c => !isJoker(c)), wild = cards.length - real.length;
  const base = real.map(rank), suit = real.length ? Math.floor(real[0] / 13) : 0;
  const canFlush = cards.length === 5 && real.every(c => Math.floor(c / 13) === suit);
  let best;
  const offer = (assigned, flush) => {
    const value = plain([...base, ...assigned], flush);
    if (position === 0 && wild >= 2 && (!upper || upper.typeId >= 4)) {
      value.typeId = 120; value.key = [3, 15, ...value.key.slice(1)];
    }
    const key = [...value.key, wild ? -1 : 0];
    if (upper && compareKey(key, upper.key) > 0) return;
    if (!best || compareKey(key, best.key) > 0) best = { ...value, key, assigned: assigned.slice(), flush };
  };
  const assigned = [];
  // Rank multisets avoid enumerating 52^jokerCount substitutions. Maximum
  // five-card work is C(17,5), and each dealt subset is memoized by arrange().
  const visit = (left, first) => {
    if (!left) { offer(assigned, canFlush); if (wild && canFlush) offer(assigned, false); return; }
    for (let r = first; r <= 14; r++) { assigned.push(r); visit(left - 1, r); assigned.pop(); }
  };
  const sameRank = base.every(r => r === base[0]);
  if (wild && position === 0 && wild >= 2 && (!upper || upper.typeId >= 4)) {
    offer(Array(wild).fill(base[0] || 14), false);
  } else if (wild && cards.length === 5 && sameRank && !upper) {
    offer(Array(wild).fill(base[0] || 14), canFlush);
  } else visit(wild, 2);
  if (!best) return null;
  let wi = 0;
  const resolved = cards.map(c => {
    if (!isJoker(c)) return c;
    const value = best.assigned[wi++];
    return rankCard(value, best.flush ? suit : (suit + (wi === 1 ? 1 : 0)) % 4);
  });
  const water = WATER[position][best.typeId] || 1;
  return { ...best, cards: cards.slice(), resolved, water, color: water > 1 ? 1 : 0,
    type: best.typeId === 120 ? 'TWO_JOKER_FRONT' : TYPES[best.typeId],
    typeName: best.typeId === 120 ? '两鬼冲头' : NAMES[best.typeId] };
}
export function sameCards(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const count = new Map();
  for (const c of a) count.set(c, (count.get(c) || 0) + 1);
  for (const c of b) { if (!count.get(c)) return false; count.set(c, count.get(c) - 1); }
  return true;
}
export function validArrangement(hole, front, middle, back) {
  return Array.isArray(front) && front.length === 3 && Array.isArray(middle) && middle.length === 5
    && Array.isArray(back) && back.length === 5 && sameCards(hole, [...front, ...middle, ...back]);
}
export function evaluate(front, middle, back) {
  const all = [...front, ...middle, ...back];
  const backHand = evaluatePile(back, 2);
  const middleHand = evaluatePile(middle, 1, backHand);
  const frontHand = middleHand && evaluatePile(front, 0, middleHand);
  const mid = middleHand || evaluatePile(middle, 1), head = frontHand || evaluatePile(front, 0);
  const isWater = !middleHand || !frontHand
    || (head.typeId === 120 && (mid.typeId < 4 || backHand.typeId < 4));
  const specialType = special(front, middle, back);
  const piles = [front, middle, back], horseAt = all.indexOf(26);
  const horseCardPosition = horseAt < 0 ? 0 : horseAt < 3 ? 1 : horseAt < 8 ? 2 : 3;
  return { isWater: specialType ? false : isWater, hasSpecialType: Boolean(specialType), specialType,
    frontHand: head, middleHand: mid, backHand,
    frontResolved: head.resolved.filter((_, i) => isJoker(front[i])),
    middleResolved: mid.resolved.filter((_, i) => isJoker(middle[i])),
    backResolved: backHand.resolved.filter((_, i) => isJoker(back[i])),
    hasHorseCard: horseAt >= 0, horseCardIndex: horseAt,
    horseCardPosition, horseCardPositionIndex: horseAt < 0 ? -1 : piles[horseCardPosition - 1].indexOf(26),
    isScoop: false, isScooped: false, totalWater: 0, specialWater: specialType?.water || 0 };
}

export function special(front, middle, back) {
  const all = [...front, ...middle, ...back];
  if (all.some(isJoker)) return null;
  const counts = new Map();
  for (const c of all) counts.set(rank(c), (counts.get(rank(c)) || 0) + 1);
  const groups = [...counts.values()];
  const flush = p => p.every(c => Math.floor(c / 13) === Math.floor(p[0] / 13));
  const straight = p => Boolean(straightKey(p.map(rank)));
  let value;
  if ([front, middle, back].every(p => flush(p) && straight(p))) value = [3, '三同花顺', 20, 3];
  else if (groups.filter(n => n === 4).length === 3) value = [4, '三分天下', 20, 2];
  else if (groups.filter(n => n >= 3).length === 4) value = [8, '四套三条', 9, 1];
  else if (groups.filter(n => n === 3).length === 1 && groups.filter(n => n === 2).length === 5) value = [9, '五对三条', 9, 1];
  else if (groups.reduce((sum, n) => sum + Math.floor(n / 2), 0) === 6) value = [11, '六对半', 6, 0];
  else if ([front, middle, back].every(straight)) value = [12, '三顺子', 6, 0];
  else if ([front, middle, back].every(flush)) value = [13, '三同花', 6, 0];
  return value ? { typeId: value[0], type: value[1], typeName: value[1], water: value[2], strength: value[3] } : null;
}

export function combinations(size, count) {
  const out = [], picked = [];
  const next = start => {
    if (picked.length === count) { out.push(picked.slice()); return; }
    for (let i = start; i <= size - count + picked.length; i++) { picked.push(i); next(i + 1); picked.pop(); }
  };
  next(0); return out;
}
const FIVE = combinations(13, 5), HEAD = combinations(8, 3);
const maskOf = indexes => indexes.reduce((mask, i) => mask | 1 << i, 0);
export function arrange(hole, limit = 3) {
  if (!Array.isArray(hole) || hole.length !== 13) return [];
  const cache = new Map();
  const pile = (indexes, position) => {
    const mask = maskOf(indexes), key = mask * 4 + position;
    if (!cache.has(key)) cache.set(key, evaluatePile(indexes.map(i => hole[i]), position));
    return cache.get(key);
  };
  const backs = FIVE.map(indexes => ({ indexes, mask: maskOf(indexes), value: pile(indexes, 2) }))
    .sort((a, b) => -compareKey(a.value.key, b.value.key));
  let options = [], seen = new Set();
  const noGhost = !hole.some(isJoker);
  // Natural specials need no wildcard search. Precompute subset properties
  // instead of recounting thirteen ranks for every one of 72,072 partitions.
  const natural = new Map();
  const attributes = indexes => {
    const mask = maskOf(indexes);
    if (!natural.has(mask)) {
      const cards = indexes.map(i => hole[i]);
      natural.set(mask, { flush: cards.every(c => Math.floor(c / 13) === Math.floor(cards[0] / 13)),
        straight: Boolean(straightKey(cards.map(rank))) });
    }
    return natural.get(mask);
  };
  const countSpecial = noGhost ? special(hole.slice(0, 3), hole.slice(3, 8), hole.slice(8)) : null;
  let naturalOption;
  if (noGhost) for (const back of backs) {
    const tail = attributes(back.indexes);
    if (!tail.flush && !tail.straight) continue;
    const rest = Array.from({ length: 13 }, (_, i) => i).filter(i => !(back.mask & 1 << i));
    for (const pick of HEAD) {
      const front = pick.map(i => rest[i]), mask = maskOf(front), middle = rest.filter(i => !(mask & 1 << i));
      const head = attributes(front), mid = attributes(middle);
      if (!(head.flush && mid.flush && tail.flush) && !(head.straight && mid.straight && tail.straight)) continue;
      const value = { front: front.map(i => hole[i]), middle: middle.map(i => hole[i]), back: back.indexes.map(i => hole[i]) };
      const sp = special(value.front, value.middle, value.back);
      if (!naturalOption || sp.strength > naturalOption.specialType.strength) naturalOption = { ...value, specialType: sp };
    }
  }
  // Ordinary recommendations search strongest tail candidates first. Masks
  // distinguish physical copies of repeated ghost cards.
  for (let bi = 0; bi < backs.length; bi++) {
    if (bi >= 96 && options.length >= limit) break;
    const back = backs[bi], rest = Array.from({ length: 13 }, (_, i) => i).filter(i => !(back.mask & 1 << i));
    for (const headPick of HEAD) {
      const frontIdx = headPick.map(i => rest[i]), frontMask = maskOf(frontIdx);
      const midIdx = rest.filter(i => !(frontMask & 1 << i));
      const mid = pile(midIdx, 1), front = pile(frontIdx, 0);
      const rawFront = frontIdx.map(i => hole[i]), rawMid = midIdx.map(i => hole[i]), rawBack = back.indexes.map(i => hole[i]);
      const sp = countSpecial && [4, 8, 9, 11].includes(countSpecial.typeId) ? countSpecial : null;
      if (!sp && (compareKey(mid.key, back.value.key) > 0 || compareKey(front.key, mid.key) > 0
        || (front.typeId === 120 && (mid.typeId < 4 || back.value.typeId < 4)))) continue;
      const key = [front.typeId, mid.typeId, back.value.typeId, sp?.typeId || 0].join('/');
      const weight = sp ? 100000 + sp.strength * 1000 + sp.water :
        (WATER[0][front.typeId] || 1) * 5 + (WATER[1][mid.typeId] || 1) * 4
          + (WATER[2][back.value.typeId] || 1) * 3 + front.typeId * 3 + mid.typeId * 2 + back.value.typeId;
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ front: rawFront, middle: rawMid, back: rawBack, weight,
        frontType: front.typeId, middleType: mid.typeId, backType: back.value.typeId,
        frontColor: front.color, middleColor: mid.color, backColor: back.value.color,
        frontResolved: front.resolved.filter((_, i) => isJoker(rawFront[i])),
        middleResolved: mid.resolved.filter((_, i) => isJoker(rawMid[i])),
        backResolved: back.value.resolved.filter((_, i) => isJoker(rawBack[i])),
        ...(sp ? { specialType: sp } : {}) });
    }
  }
  if (naturalOption) {
    const { front, middle, back, specialType } = naturalOption;
    if (!countSpecial || specialType.strength >= countSpecial.strength) options.push({
      ...naturalOption, weight: 100000 + specialType.strength * 1000 + specialType.water,
      frontType: evaluatePile(front, 0).typeId, middleType: evaluatePile(middle, 1).typeId,
      backType: evaluatePile(back, 2).typeId, frontColor: 0, middleColor: 0, backColor: 0,
      frontResolved: [], middleResolved: [], backResolved: [] });
  }
  options.sort((a, b) => b.weight - a.weight);
  return options.slice(0, limit).map(({ weight, ...value }) => value);
}
