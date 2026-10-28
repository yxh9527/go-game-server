import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { counts, rank, suit } = await rel(import.meta.url, './tiles.js', v);

// Memoized decomposition with exact joker consumption. A joker cannot erase
// a real unmatched tile, and runs never cross a suit or contain honor tiles.
export function meldsPossible(input, wild, sets, triplesOnly = false) {
  const c = input.slice(), memo = new Map();
  function visit(w, left) {
    const first = c.findIndex(n => n > 0);
    if (first < 0) return w === left * 3;
    if (left <= 0) return false;
    const key = `${w}/${left}/${c.join(',')}`;
    if (memo.has(key)) return memo.get(key);
    const take = Math.min(3, c[first]);
    if (3 - take <= w) {
      c[first] -= take;
      const ok = visit(w - (3 - take), left - 1);
      c[first] += take;
      if (ok) { memo.set(key, true); return true; }
    }
    if (!triplesOnly && first < 27) {
      for (let start = Math.max(Math.floor(first / 9) * 9, first - 2); start <= first && start % 9 <= 6; start++) {
        const used = [], missing = [];
        for (let t = start; t < start + 3; t++) { if (c[t] > 0) { c[t]--; used.push(t); } else missing.push(t); }
        const ok = missing.length <= w && visit(w - missing.length, left - 1);
        for (const t of used) c[t]++;
        if (ok) { memo.set(key, true); return true; }
      }
    }
    memo.set(key, false); return false;
  }
  return visit(wild, sets);
}
export function shapes(cards, groupCount, family, pair258 = false) {
  const size = family === 'jsmj' ? 5 : 14, sets = (size - 2) / 3 - groupCount;
  const result = { standard: false, allTriples: false, sevenPairs: false, luxury: 0 };
  if (sets < 0 || cards.length !== sets * 3 + 2 || cards.some(c => !Number.isInteger(c) || c < 0 || c >= (family === 'jsmj' ? 30 : family === 'hzxl' ? 28 : 27))) return result;
  const c = counts(cards), wild = family === 'hzxl' ? c[27] : 0;
  if (c.some((n, i) => n > (family === 'hzxl' && i === 27 ? 8 : 4))) return result;
  if (family === 'hzxl') c[27] = 0;
  if (size === 14 && groupCount === 0) {
    const missing = c.reduce((n, x) => n + x % 2, 0);
    result.sevenPairs = missing <= wild && (wild - missing) % 2 === 0;
    result.luxury = c.reduce((n, x) => n + Math.floor(x / 4), 0);
  }
  for (let pair = 0; pair < (family === 'jsmj' ? 30 : 27); pair++) {
    if (pair258 && ![2, 5, 8].includes(rank(pair))) continue;
    const take = Math.min(2, c[pair]), need = 2 - take;
    if (need > wild) continue;
    c[pair] -= take;
    result.standard ||= meldsPossible(c, wild - need, sets);
    result.allTriples ||= meldsPossible(c, wild - need, sets, true);
    c[pair] += take;
    if (result.standard && result.allTriples) break;
  }
  return result;
}
export function smallHu(cards, mid = false) {
  const c = counts(cards), types = [];
  if (c.some(n => n === 4)) types.push(mid ? 101 : 1);
  if (c.filter(n => n >= 3).length >= 2) types.push(mid ? 102 : 2);
  if (mid) return types;
  if ([1, 2, 3].some(s => !cards.some(c => suit(c) === s))) types.push(3);
  if (cards.every(c => ![2, 5, 8].includes(rank(c)))) types.push(4);
  if ([0, 9, 18].some(start => cards.filter(c => c >= start && c < start + 9).length === 1 && c[start + 4] === 1)) types.push(5);
  if ([0, 9, 18].some(start => Array.from({ length: 7 }, (_, i) => i + start).some(t => c[t] >= 2 && c[t + 1] >= 2 && c[t + 2] >= 2))) types.push(6);
  if (Array.from({ length: 9 }, (_, i) => i).some(t => c[t] >= 2 && c[t + 9] >= 2 && c[t + 18] >= 2)) types.push(7);
  if (cards.filter(c => [2, 5, 8].includes(rank(c))).length === 1) types.push(8);
  return types;
}
// Test a required triplet pattern against actual melds and the remaining
// concealed tiles. Jokers spent on the pattern cannot also complete the rest.
function tripletPattern(cards, groups, faces, allTriples = false) {
  const remaining = cards.slice(); let extraGroups = 0;
  for (const face of faces) {
    if (groups.some(g => g.card === face && g.type !== 12)) continue;
    for (let n = 0; n < 3; n++) {
      let i = remaining.indexOf(face); if (i < 0) i = remaining.indexOf(27);
      if (i < 0) return false; remaining.splice(i, 1);
    }
    extraGroups++;
  }
  const result = shapes(remaining, groups.length + extraGroups, 'hzxl');
  return allTriples ? result.allTriples : result.standard;
}
function consecutiveTriplets(cards, groups, length, suitCount) {
  for (let start = 0; start <= 9 - length; start++) {
    const faces = [];
    function visit(i) {
      if (i === length) return new Set(faces.map(suit)).size === suitCount && tripletPattern(cards, groups, faces, true);
      for (const offset of [0, 9, 18]) {
        const face = offset + start + i;
        if (cards.filter(c => c === face || c === 27).length < 3 && !groups.some(g => g.card === face)) continue;
        faces.push(face); if (visit(i + 1)) return true; faces.pop();
      }
      return false;
    }
    if (visit(0)) return true;
  }
  return false;
}
function containsRunWithJokers(cards, groups, start) {
  const assigned = cards.slice(), all = counts(cards.concat(groups.flatMap(g => g.cards)));
  for (let t = start; t < start + 9; t++) if (!all[t]) {
    const i = assigned.indexOf(27); if (i < 0) return false; assigned[i] = t;
  }
  return shapes(assigned, groups.length, 'hzxl').standard;
}
export function evaluate(cards, groups, r, context = {}) {
  const family = r.family, ordinary = shapes(cards, groups.length, family);
  if (cards.length !== (family === 'jsmj' ? 5 : 14) - groups.length * 3) return null;
  const all = cards.concat(groups.flatMap(g => g.cards || Array(g.num || (g.type === 3 || g.type === 12 ? 3 : 4)).fill(g.card)));
  const natural = all.filter(c => family !== 'hzxl' || c !== 27), types = [], add = (huType, fan) => types.push({ huType, fan });
  if (family === 'jsmj') {
    if (!ordinary.standard) return null;
    add(0, all.reduce((n, c) => n + rank(c), 0));
    if (context.selfDraw) add(1, 10);
    if (context.ting) add(context.heavenTing ? 5 : 2, context.heavenTing ? 20 : 10);
    if (new Set(all.map(suit)).size === 1 && all.every(c => c < 27)) add(3, 10);
    if (ordinary.allTriples) add(4, 20);
    if (all.every(c => c >= 27)) add(7, 30);
    if (context.afterKong) add(6, 30);
    if (context.earth) add(8, 40);
    if (context.heaven) add(9, 80);
    // Flowers are paid once on the physical draw; they are a separate ledger
    // category and must not be charged a second time when the player wins.
    const fan = types.reduce((n, t) => n + t.fan, 0) + cards.filter(c => c === context.addFanCard).length;
    return { fan, types, base: types[0], additional: types.slice(1) };
  }
  if (family === 'csmj') {
    const pure = new Set(natural.map(suit)).size === 1;
    const jiang = all.every(c => [2, 5, 8].includes(rank(c)));
    if (ordinary.allTriples && !groups.some(g => g.type === 12)) add(202, 4);
    if (groups.length === 4 && groups.every(g => g.type !== 4) && !context.selfDraw && ordinary.standard) add(203, 4);
    if (pure && (ordinary.standard || ordinary.sevenPairs)) add(204, 4);
    if (jiang && (ordinary.standard || ordinary.sevenPairs)) add(205, 4);
    if (ordinary.sevenPairs) add(206 + ordinary.luxury, 4 * (ordinary.luxury + 1));
    if (!types.length && !shapes(cards, groups.length, family, true).standard) return null;
    if (!types.length) add(201, 1);
    let fan = Math.max(...types.map(t => t.fan));
    for (const [yes, id] of [[context.heaven, 301], [context.earth, 302], [context.afterKong, 303], [context.robKong, 304], [context.kongDiscard, 305], [context.lastCard && context.selfDraw, 306], [context.lastCard && !context.selfDraw, 307]]) if (yes) { add(id, 4); fan *= 4; }
    return { fan, types, base: types[0], additional: types.slice(1) };
  }
  if (natural.some(c => suit(c) === context.queType) || !(ordinary.standard || ordinary.sevenPairs)) return null;
  const c = counts(natural), bases = [{ huType: 10, fan: 2 }];
  if (ordinary.allTriples && !groups.some(g => g.type === 12)) {
    bases.push({ huType: 9, fan: 4 });
    if (natural.every(c => rank(c) % 2 === 1)) bases.push({ huType: 1, fan: 32 });
    if (natural.every(c => rank(c) % 2 === 0)) bases.push({ huType: 2, fan: 32 });
    for (const [n, s, huType, fan] of [[4,1,3,32],[4,2,4,24],[3,1,5,16],[3,2,7,12]])
      if (consecutiveTriplets(cards, groups, n, s)) bases.push({ huType, fan });
  }
  if (ordinary.sevenPairs) bases.push({ huType: 8, fan: 6 });
  for (const start of [0, 9, 18]) {
    if (containsRunWithJokers(cards, groups, start)) bases.push({ huType: 6, fan: 16 });
    if (groups.length === 0 && natural.every(t => t >= start && t < start + 9)
      && [3,1,1,1,1,1,1,1,3].reduce((n, count, i) => n + Math.max(0, count - c[start + i]), 0) <= cards.filter(c => c === 27).length) bases.push({ huType: 0, fan: 128 });
  }
  const base = bases.sort((a, b) => b.fan - a.fan)[0]; types.push(base);
  if (natural.length && natural.every(c => rank(c) > 5)) add(11, 4);
  if (natural.length && natural.every(c => rank(c) < 5)) add(12, 4);
  if (cards.length === 2) add(13, 4);
  if (new Set(natural.map(suit)).size === 1) add(14, 4);
  if (natural.every(t => (suit(t) === 2 && [1, 2, 3, 4, 5, 8, 9].includes(rank(t))) || (suit(t) === 3 && [2, 4, 5, 6, 8, 9].includes(rank(t))))) add(15, 2);
  if (groups.every(g => g.type === 4)) add(16, 2);
  if (natural.every(t => rank(t) >= 2 && rank(t) <= 8)) add(17, 2);
  if (Array.from({ length: 9 }, (_, i) => i).some(t => [[t,t+9],[t,t+18],[t+9,t+18]].some(pair => tripletPattern(cards, groups, pair)))) add(18, 2);
  if (context.selfDraw) add(19, 2);
  for (let n = 0; n < (context.roots || 0); n++) add(20, 2);
  for (let n = 0; n < (context.redKongs || 0); n++) add(21, 2);
  if (context.afterKong) add(22, 2);
  if (context.kongDiscard) add(23, 2);
  if (context.lastCard && context.selfDraw) add(24, 2);
  return { fan: Math.min(512, types.reduce((n, t) => n * t.fan, 1)), types, base, additional: types.slice(1) };
}
