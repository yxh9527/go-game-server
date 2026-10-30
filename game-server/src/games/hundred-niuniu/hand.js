import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { makeDeck, shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { evaluate, compareHands } = await rel(import.meta.url, '../niuniu/hand.js', v);
export const areaIds = Object.freeze([1, 2, 3, 4, 5, 6]);
export const positions = Object.freeze(['a', 'b', 'c', 'banker']);
// Original Bairen help includes silver through straight-flush. Use ordinary
// ranking, never ordinary all-blind mode's different ranking or multipliers.
const rankRules = Object.freeze({ playMode: 1, specialCode: [0], specialQiLaiCode: [], doubleRule: 1 });
export const rankHand = cards => evaluate(cards, rankRules);
export { compareHands };
// Help caps liability at ten times the stake. The editable special tier has
// a documented development default; ordinary room multipliers are unrelated.
export const payoutMultiple = (rank, special = 10) => rank.niuType > 10 ? special : Math.max(1, rank.niuType);
export function betNet(hand, bet, odds) {
  // Never retroactively multiply liability accepted by an earlier hot module.
  // Old development hands reserved one stake; only new ten-reserve hands use
  // Niuniu multipliers. The next round adopts the current policy normally.
  if ((hand.betReserveFactor || 1) !== 10) return hand.winningAreas.includes(bet.areaId)
    ? Number(BigInt(bet.total) * BigInt(Math.round(odds[bet.areaId] * 1000)) / 1000n) : -bet.total;
  const side = positions[(bet.areaId - 1) % 3];
  const rank = compareHands(hand.ranks[side], hand.ranks.banker) > 0 ? hand.ranks[side] : hand.ranks.banker;
  const total = bet.total * payoutMultiple(rank, hand.specialPayoutMultiple);
  return hand.winningAreas.includes(bet.areaId)
    ? Number(BigInt(total) * BigInt(Math.round(odds[bet.areaId] * 1000)) / 1000n) : -total;
}
export function createHand(_table, rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const cards = Object.fromEntries(positions.map((key, i) => [key, deck.slice(i * 5, i * 5 + 5)]));
  const ranks = Object.fromEntries(positions.map(key => [key, rankHand(cards[key])]));
  const winningAreas = positions.slice(0, 3).map((key, i) => compareHands(ranks[key], ranks.banker) > 0 ? i + 1 : i + 4);
  return { cards, ranks, winningAreas, dealt: deck.slice(0, 20), publicIndices: new Set(), createdAt: 0 };
}
export const visibleCards = (hand, rules) => Object.fromEntries(positions.map(key =>
  [key, hand.cards[key].map((card, i) => i < rules.visibleCount ? card : -1)]));
export const resultCards = hand => Object.fromEntries(positions.map(key => [key, hand.cards[key].slice()]));
export const showdownTypes = hand => Object.fromEntries(positions.map(key => [key, hand.ranks[key].niuType]));
export const outcome = hand => ({ winningAreas: hand.winningAreas.slice(), tieAreas: [],
  lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)) });
function ensureRoads(table) {
  // A resident room may have been created by the early array-shaped adapter.
  // Convert public history only; do not replace its hand, bets or wallet state.
  if (Array.isArray(table.ways)) {
    const records = table.ways.slice(-100);
    table.ways = { 1: { max: 100, ways: Object.fromEntries([1,2,3].map(id => [id, records.map(row => row[id-1])])) },
      2: { max: 100, ways: records } };
    Object.assign(table.ways[2], statistics(table));
  }
}
export const roadSnapshot = table => { ensureRoads(table); return table.ways; };
export function updateRoads(table, hand) {
  ensureRoads(table);
  const records = [...table.ways[2].ways, positions.slice(0, 3).map((_, i) => hand.winningAreas.includes(i + 1) ? 1 : -1)].slice(-100);
  table.ways[1].ways = Object.fromEntries([1, 2, 3].map(id => [id, records.map(row => row[id - 1])]));
  table.ways[2].ways = records;
  Object.assign(table.ways[2], statistics(table));
}
export function statistics(table) {
  ensureRoads(table);
  return Object.fromEntries(positions.slice(0, 3).map((key, i) => [key + 'WinCount',
    table.ways[2].ways.reduce((sum, row) => sum + (row[i] === 1 ? 1 : 0), 0)]));
}
// Deterministic, bounded development pricing from PUBLIC cards only. Every
// simulation deals disjoint unknown cards and excludes all four public hands.
// This is a fair probability estimate, not an asserted online house formula.
export function conditionalOdds(visible, samples = 2048, specialPayoutMultiple = 10) {
  const known = positions.flatMap(key => visible[key].filter(card => card >= 0));
  if (known.length !== new Set(known).size || positions.some(key => visible[key].length !== 5)
    || positions.some(key => visible[key].some(card => !Number.isInteger(card) || card < -1 || card > 51))) throw new Error('Invalid public cards');
  if (!known.length) return Object.fromEntries(areaIds.map(id => [id, 1]));
  if (!Number.isInteger(samples) || samples < 1 || samples > 16384) throw new Error('Invalid pricing sample limit');
  let seed = 2166136261;
  for (const key of positions) for (const card of visible[key]) seed = Math.imul(seed ^ (card + 2), 16777619) >>> 0;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const deck = makeDeck().filter(card => !known.includes(card));
  const wins = [0, 0, 0], losses = [0, 0, 0];
  for (let n = 0; n < samples; n++) {
    const pool = deck.slice(); let cursor = 0;
    const ranks = positions.map(key => rankHand(visible[key].map(card => {
      if (card >= 0) return card;
      const j = cursor + Math.floor(rng() * (pool.length - cursor));
      [pool[cursor], pool[j]] = [pool[j], pool[cursor]];
      return pool[cursor++];
    })));
    for (let i = 0; i < 3; i++) {
      if (compareHands(ranks[i], ranks[3]) > 0) wins[i] += payoutMultiple(ranks[i], specialPayoutMultiple);
      else losses[i] += payoutMultiple(ranks[3], specialPayoutMultiple);
    }
  }
  // A continuity correction prevents a rare event missed by finite samples
  // becoming a false impossible event. It never depends on actual hidden cards.
  const odds = {};
  wins.forEach((count, i) => {
    odds[i + 1] = Math.floor((losses[i] + 0.5) / (count + 0.5) * 1000) / 1000;
    odds[i + 4] = Math.floor((count + 0.5) / (losses[i] + 0.5) * 1000) / 1000;
  });
  return odds;
}
export function prepareRound(table, hand) {
  hand.specialPayoutMultiple = table.rules.specialPayoutMultiple ?? 10;
  hand.areaOdds = conditionalOdds(visibleCards(hand, table.rules), 2048, hand.specialPayoutMultiple);
  table.rules.betAreaOdds = { ...hand.areaOdds };
}
export default { areaIds, createHand, visibleCards, resultCards, showdownTypes, outcome,
  roadSnapshot, updateRoads, prepareRound, statistics, betNet,
  emptyCards: () => Object.fromEntries(positions.map(key => [key, [-1, -1, -1, -1, -1]])),
  visibleShowdown: visible => visible, snapshotCards: visible => visible,
};
