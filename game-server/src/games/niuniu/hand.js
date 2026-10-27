// Card IDs follow the original client: 0..51 diamond/club/heart/spade A..K;
// 52 small joker, 53 big joker, 54 sky; 55..67 are wildcard A..K sprites.
export const rank = card => card % 13 + 1;
const point = value => Math.min(value, 10);
const enabled = (codes, code) => codes.includes(0) || codes.includes(code);
const normalNames = ['NONE', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'NIUNIU',
  'SILVER', 'STRAIGHT', 'GOLD', 'FLUSH', 'FULL_HOUSE', 'FOUR_KIND', 'FIVE_SMALL', 'STRAIGHT_FLUSH'];
const wildNames = [...normalNames.slice(0, 11), 'SMALL_JOKER', 'BIG_JOKER', 'SKY', 'SILVER', 'STRAIGHT',
  'FLUSH', 'GOLD', 'FULL_HOUSE', 'FOUR_KIND', 'FIVE_SMALL', 'EARTH_DRAGON', 'SKY_DRAGON', 'STRAIGHT_FLUSH',
  'ROCKET', 'MARS', 'VENUS', 'ROYAL_EARTH_DRAGON', 'ROYAL_SKY_DRAGON', 'FIVE_KIND', 'STAR_KING', 'SKY_KING'];

export function niuTriple(values) {
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 5; c++) {
    if ((point(values[a]) + point(values[b]) + point(values[c])) % 10 === 0) return [a, b, c];
  }
  return [];
}

function classify(cards, values, rules, wild, wildMask) {
  const counts = new Map();
  values.forEach(v => counts.set(v, (counts.get(v) || 0) + 1));
  const groups = [...counts.values()].sort((a, b) => b - a);
  const sorted = [...counts.keys()].sort((a, b) => a - b);
  const wheel = sorted.length === 5 && sorted.every((n, i) => n === i + 1);
  const royal = sorted.join(',') === '1,10,11,12,13';
  const straight = sorted.length === 5 && (sorted[4] - sorted[0] === 4 || royal);
  const naturals = cards.filter((_, i) => !wildMask[i]);
  const flush = (naturals.length === 0 || naturals.every(c => Math.floor(c / 13) === Math.floor(naturals[0] / 13))) && groups[0] === 1;
  const small = values.every(v => v < 5) && values.reduce((a, b) => a + b, 0) <= 10;
  const gold = values.every(v => v >= 11);
  const silver = values.every(v => v >= 10) && (wild || values.filter(v => v === 10).length === 1);
  const triple = niuTriple(values);
  const niu = triple.length ? values.reduce((a, b) => a + point(b), 0) % 10 || 10 : 0;
  let type = niu, strength = niu;
  const set = (id, code, condition, order = id) => {
    if (condition && enabled(wild ? rules.specialQiLaiCode : rules.specialCode, code) && order > strength) {
      type = id; strength = order;
    }
  };
  if (wild) {
    set(11, 11, cards.includes(52)); set(12, 12, cards.includes(53)); set(13, 13, cards.includes(54));
    set(14, 14, silver); set(15, 15, straight); set(16, 16, flush); set(17, 17, gold);
    set(18, 18, groups[0] === 3 && groups[1] === 2); set(19, 19, groups[0] === 4);
    set(20, 20, small); set(21, 21, wheel); set(22, 22, royal); set(23, 23, flush && straight);
    set(24, 24, cards.includes(52) && cards.includes(53));
    set(25, 25, cards.includes(52) && cards.includes(54));
    set(26, 26, cards.includes(53) && cards.includes(54));
    set(27, 27, flush && wheel); set(28, 28, flush && royal); set(29, 29, groups[0] === 5);
    const threeJokers = [52, 53, 54].every(c => cards.includes(c));
    set(30, 30, threeJokers);
    set(31, 31, threeJokers && values.every((v, i) => cards[i] >= 52 || v === 1)
      && cards.every((c, i) => c >= 52 || !wildMask[i] || values[i] === 1));
  } else if (rules.playMode === 0) {
    // All-blind uses the same sprite IDs, a different ordering and multipliers.
    set(11, 11, silver, 11); set(13, 13, gold, 12);
    set(16, 17, groups[0] === 4, 13); set(17, 6, small, 14);
  } else {
    // Silver is part of the base ordinary ranking, not one of the seven
    // optional specialCode entries listed by the original settings panel.
    if (silver) { type = 11; strength = 11; }
    set(12, 1, straight); set(13, 2, gold);
    set(14, 3, flush); set(15, 4, groups[0] === 3 && groups[1] === 2);
    set(16, 5, groups[0] === 4); set(17, 6, small); set(18, 7, flush && straight);
  }
  const multiplier = wild ? [1,1,2,3,4,5,6,7,8,9,10,11,12,13,15,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,35][type]
    : rules.playMode === 0 ? type > 10 ? 4 : type === 10 ? 3 : type >= 7 ? 2 : 1
      : type > 10 ? [0,4,5,5,5,6,6,8,8][type - 10]
        : type === 10 ? (rules.doubleRule === 2 ? 3 : 4) : type === 9 ? (rules.doubleRule === 2 ? 2 : 3)
          : type === 8 || type === 7 && rules.doubleRule !== 2 ? 2 : 1;
  // The wildcard itself never wins a same-type tie. Sky-dragon compares A high.
  const aceHigh = wild && [22,28].includes(type);
  const tie = naturals.map(c => (aceHigh && rank(c) === 1 ? 14 : rank(c)) * 4 + Math.floor(c / 13)).sort((a,b) => b-a);
  return { niuType: type, niuJi: type, belv: multiplier, strength,
    cardType: (wild ? wildNames : normalNames)[type], qilaiCardType: (wild ? wildNames : normalNames)[type],
    tie: tie.length ? [tie[0]] : [0], triple, values: values.slice() };
}

export function compareHands(a, b) {
  return Math.sign(a.strength - b.strength || a.tie[0] - b.tie[0]);
}

export function evaluate(cards, rules, laiZi = -1) {
  const wild = rules.playMode === 7;
  if (cards.length !== 5 || new Set(cards).size !== 5 || cards.some(c => !Number.isInteger(c) || c < 0 || c > (wild ? 54 : 51))) {
    throw new Error('牛牛 requires five distinct legal cards');
  }
  const wildMask = cards.map(c => wild && (c >= 52 || rank(c) === rank(laiZi)));
  const indices = cards.map((_, i) => i).filter(i => wildMask[i]);
  const values = cards.map(c => c < 52 ? rank(c) : 1);
  let best;
  // Wildcards are interchangeable. Sorted assignments cover all rank multisets
  // (at most C(17,5)=6188), not 52^5 substitutions; suits are chosen by feasibility.
  function visit(depth, minimum) {
    if (depth === indices.length) {
      const candidate = classify(cards, values, rules, wild, wildMask);
      if (!best || compareHands(candidate, best) > 0) best = candidate;
      return;
    }
    for (let n = minimum; n <= 13; n++) { values[indices[depth]] = n; visit(depth + 1, n); }
  }
  visit(0, 1);
  const logical = cards.map((c, i) => wildMask[i] ? 54 + best.values[i] : c);
  const combinations = best.triple.map(i => cards[i]);
  return { ...best, cardList: cards.slice(), handCardListWithLaiZi: logical,
    combinationsCard: combinations, wildMask };
}
