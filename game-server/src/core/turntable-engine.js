import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { createBairenEngine } = await rel(import.meta.url, './bairen-engine.js', v);
const { AREA_IDS, winningAreas, betNet } = await rel(import.meta.url, './turntable-rules.js', v);

export const phases = Object.freeze({ IDLE: -1, DEALING: 1, BETTING: 2, SHOWDOWN: 4, SETTLING: 6, STATS: 10, ENDED: 0 });
export function createHand(table, rng = Math.random) {
  const outer = table.defaultOuter || table.rules.defaultOuter;
  const inner = table.defaultInner || table.rules.defaultInner;
  const outerIndex = Math.floor(rng() * outer.length), innerIndex = Math.floor(rng() * inner.length);
  const outerValue = outer[outerIndex], innerValue = inner[innerIndex];
  return { outerIndex, innerIndex, outerValue, innerValue, nextInner: inner.slice(),
    winningAreas: winningAreas(outerValue, innerValue), tieAreas: [],
    areaOdds: { ...table.rules.betAreaOdds } };
}
export const outcome = hand => ({ winningAreas: hand.winningAreas.slice(), tieAreas: [],
  lostAreas: AREA_IDS.filter(id => !hand.winningAreas.includes(id)) });
export function resultFields(_table, hand) {
  return { outerIndex: hand.outerIndex, innerIndex: hand.innerIndex, outerValue: hand.outerValue,
    innerValue: hand.innerValue, nextInner: hand.nextInner.slice(), areaOdds: { ...hand.areaOdds } };
}
export function updateRoads(table, hand) {
  table.outerIndex = hand.outerIndex; table.innerIndex = hand.innerIndex;
  table.ways[1].ways = [...table.ways[1].ways, hand.innerValue].slice(-100);
  table.ways[2].ways = [...table.ways[2].ways, { innerValue: hand.innerValue, outerValue: hand.outerValue }].slice(-100);
  const counts = table.ways[2].winCountMap ||= {};
  counts[hand.innerValue] = (counts[hand.innerValue] || 0) + 1;
  table.consecutiveWinCounts ||= {};
  for (const id of AREA_IDS) table.consecutiveWinCounts[id] = hand.winningAreas.includes(id)
    ? (table.consecutiveWinCounts[id] || 0) + 1 : 0;
}
export const engine = createBairenEngine({
  phases, areaIds: AREA_IDS, createHand, outcome, updateRoads, resultFields,
  emptyCards: () => ({}), visibleCards: () => ({}), resultCards: () => ({}),
  showdownTypes: () => ({}), visibleShowdown: () => ({}), roadSnapshot: table => table.ways,
  personalResult: true, betNet, startBetting: true, revealSeconds: () => 3, settleSeconds: 15,
  statistics: table => ({ defaultOuter: (table.defaultOuter || table.rules.defaultOuter).slice(),
    defaultInner: (table.defaultInner || table.rules.defaultInner).slice(),
    outerIndex: table.outerIndex || 0, innerIndex: table.innerIndex || 0 }),
  validateBet: (table, bets) => [...bets].every(([id,total]) => {
    const odds = (table.hand?.areaOdds || table.rules.betAreaOdds)[id];
    return odds >= 0.1 || total >= (odds < 0.01 ? 1000 : 100);
  }),
});
