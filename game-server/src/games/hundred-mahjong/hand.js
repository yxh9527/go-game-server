import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
export const areaIds = Object.freeze(Array.from({ length: 11 }, (_, i) => i + 1));
// Original atlas: 0..8 = one through nine dots, 29 = white dragon.
export const WHITE = 29;
export const tileIds = Object.freeze([...Array.from({ length: 9 }, (_, i) => i), WHITE]);
export const makeDeck = () => Array.from({ length: 40 }, (_, i) => tileIds[i % 10]);
export function evaluate(cards) {
  if (cards.length !== 2 || cards.some(c => !tileIds.includes(c)))
    throw new Error('Invalid hundred Mahjong cards');
  const [a, b] = cards, pair = a === b;
  const points = cards.reduce((n, c) => n + (c === WHITE ? 0.5 : c + 1), 0) % 10;
  const cardType = pair ? (a === WHITE ? 1 : 10 - a)
    : cards.includes(1) && cards.includes(7) ? 11 : points === 0 ? 30 : 31 - points * 2;
  return { cardType, points, pair, high: Math.max(...cards.map(c => c === WHITE ? 0.5 : c + 1)) };
}
export function compare(player, banker) {
  const a = evaluate(player), b = evaluate(banker);
  return Math.sign(b.cardType - a.cardType || a.high - b.high);
}
export function outcomes(player, banker) {
  const a = evaluate(player), b = evaluate(banker), result = compare(player, banker);
  const winningAreas = [result > 0 ? 1 : result < 0 ? 2 : 3];
  if (a.pair) winningAreas.push(4);
  if (b.pair) winningAreas.push(5);
  if (result < 0 && b.cardType === 19) winningAreas.push(6);
  if (result > 0 && a.cardType === 17) winningAreas.push(7);
  if (!a.pair && !b.pair && player.includes(WHITE) && banker.includes(WHITE)) winningAreas.push(8);
  if (a.pair && b.pair) winningAreas.push(9);
  if (a.cardType === 13 && b.cardType === 13) winningAreas.push(10);
  if (a.cardType === 30 && b.cardType === 30) winningAreas.push(11);
  const tieAreas = result === 0 ? [1, 2] : [];
  return { winningAreas, tieAreas, lostAreas: areaIds.filter(id => !winningAreas.includes(id) && !tieAreas.includes(id)) };
}
export function createHand(_table, rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const player = [deck[0], deck[2]], banker = [deck[1], deck[3]];
  return { player, banker, ...outcomes(player, banker), createdAt: 0 };
}
export const visibleCards = hand => ({ playerCards: [hand.player[0], -1], bankerCards: [hand.banker[0], -1] });
export const resultCards = hand => ({ player: hand.player.slice(), banker: hand.banker.slice() });
export const showdownTypes = hand => ({ player: evaluate(hand.player).cardType, banker: evaluate(hand.banker).cardType });
export const outcome = hand => ({ winningAreas: hand.winningAreas.slice(), tieAreas: hand.tieAreas.slice(), lostAreas: hand.lostAreas.slice() });
// Exhaust all 38 * 37 ordered physical draws given the two PUBLIC tiles.
// Development fair net odds; the captured production pricing margin is unknown.
export function conditionalOutcomes(playerFirst, bankerFirst) {
  if ([playerFirst, bankerFirst].some(c => !tileIds.includes(c)))
    throw new Error('Invalid public hundred Mahjong cards');
  const counts = Object.fromEntries(tileIds.map(id => [id, 4])); counts[playerFirst]--; counts[bankerFirst]--;
  const wins = Object.fromEntries(areaIds.map(id => [id, 0])), ties = { ...wins };
  let total = 0;
  for (const a of tileIds) for (const b of tileIds) {
    const weight = counts[a] * (counts[b] - Number(a === b));
    if (!weight) continue;
    const result = outcomes([playerFirst, a], [bankerFirst, b]);
    total += weight;
    for (const id of result.winningAreas) wins[id] += weight;
    for (const id of result.tieAreas) ties[id] += weight;
  }
  return { total, wins, ties };
}
export function prepareRound(table, hand) {
  const { total, wins, ties } = conditionalOutcomes(hand.player[0], hand.banker[0]);
  hand.areaOdds = Object.fromEntries(areaIds.map(id => [id, wins[id]
    ? Math.floor((total - wins[id] - ties[id]) * 1000 / wins[id]) / 1000 : -1]));
  table.rules.betAreaOdds = { ...hand.areaOdds };
}
export function betNet(hand, bet, odds) {
  if (hand.tieAreas.includes(bet.areaId)) return 0;
  if (!hand.winningAreas.includes(bet.areaId)) return -bet.total;
  return Number(BigInt(bet.total) * BigInt(Math.round(odds[bet.areaId] * 1000)) / 1000n);
}
export const roadSnapshot = table => table.ways;
export function updateRoads(table, hand) {
  table.ways[1].ways = [...table.ways[1].ways, { winArea: hand.winningAreas.slice(), isLiPai: false }].slice(-100);
}
export default { areaIds, createHand, visibleCards, resultCards, showdownTypes, outcome, prepareRound, betNet,
  roadSnapshot, updateRoads, personalResult: true, validateBet: () => true,
  emptyCards: () => ({ bankerCards: [-1, -1], playerCards: [-1, -1] }),
  snapshotCards: visible => ({ bankerCards: visible.bankerCards, playerCards: visible.playerCards }),
  visibleShowdown: visible => ({ banker: visible.bankerCards, player: visible.playerCards }),
};
