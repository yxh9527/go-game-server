import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
export const areaIds = Object.freeze([1, 2, 3, 4, 5, 6]);
export const positions = Object.freeze(['a', 'b', 'c', 'banker']);
export const phases = Object.freeze({ IDLE: 0, DEALING: 1, BETTING: 2, STOP_BETTING: 3,
  SHOWDOWN: 4, COMPARING: 5, SETTLING: 6, ENDED: 7, SHUFFLING: 8 });
export const TYPE = Object.freeze({ NORMAL: 1, FIVE_DRAGON: 2, BLACK_JACK: 3, BUST: 4 });
export function evaluate(cards) {
  if (!cards.length || cards.some(c => !Number.isInteger(c) || c < 0 || c > 51)) throw new Error('Invalid Blackjack cards');
  const low = cards.reduce((sum, card) => sum + Math.min(card % 13 + 1, 10), 0);
  const high = cards.some(card => card % 13 === 0) && low + 10 <= 21 ? low + 10 : low;
  const cardType = low > 21 ? TYPE.BUST : cards.length === 2 && high === 21 ? TYPE.BLACK_JACK
    : cards.length >= 5 ? TYPE.FIVE_DRAGON : TYPE.NORMAL;
  return { point: low, pointAlt: high, finalPoint: high, cardType };
}
export function compare(player, banker) {
  const a = evaluate(player), b = evaluate(banker);
  const priority = rank => rank.cardType === TYPE.BUST ? 0 : rank.cardType === TYPE.BLACK_JACK ? 3
    : rank.cardType === TYPE.FIVE_DRAGON ? 2 : 1;
  const delta = priority(a) - priority(b);
  if (delta) return Math.sign(delta);
  return a.cardType === TYPE.NORMAL ? Math.sign(a.finalPoint - b.finalPoint) : 0;
}
export const makeShoe = () => Array.from({ length: 312 }, (_, i) => i % 52);
export function newShoe(table, rng = Math.random) {
  table.blackjackShoe = { cards: shuffle(makeShoe(), rng), cursor: 0, cutIndex: table.rules.cutIndex };
  return table.blackjackShoe;
}
function complete(cards, draw) {
  const initial = evaluate(cards), supplySteps = [];
  while (cards.length < 5 && evaluate(cards).finalPoint < 17) {
    const card = draw(); cards.push(card);
    const rank = evaluate(cards);
    supplySteps.push({ card, point: rank.point, pointAlt: rank.pointAlt, cardType: rank.cardType });
  }
  const final = evaluate(cards);
  return { initialCardType: initial.cardType, cardType: final.cardType, finalCards: cards.slice(),
    firstPoint: initial.point, firstPointAlt: initial.pointAlt, finalPoint: final.finalPoint, supplySteps };
}
export function createHand(table, rng = Math.random) {
  const shoe = table.blackjackShoe || newShoe(table, rng);
  if (shoe.cursor >= shoe.cutIndex || shoe.cards.length - shoe.cursor < 20) throw new Error('Blackjack shoe requires shuffle');
  const start = shoe.cursor;
  const draw = () => shoe.cards[shoe.cursor++];
  const cards = Object.fromEntries(positions.map(key => [key, []]));
  for (let round = 0; round < 2; round++) for (const key of positions) cards[key].push(draw());
  const infos = positions.map(area => ({ area, ...complete(cards[area], draw) }));
  const winningAreas = [], tieAreas = [], lostAreas = [];
  positions.slice(0, 3).forEach((key, i) => {
    const result = compare(cards[key], cards.banker);
    if (!result) tieAreas.push(i + 1, i + 4);
    else { winningAreas.push(result > 0 ? i + 1 : i + 4); lostAreas.push(result > 0 ? i + 4 : i + 1); }
  });
  return { cards, blackJackAreaInfos: infos, winningAreas, tieAreas, lostAreas,
    shoeStart: start, shoeEnd: shoe.cursor, pricingPool: shoe.cards.slice(start), createdAt: 0 };
}
export const visibleCards = hand => Object.fromEntries(positions.map(key => [key + 'Cards', [hand.cards[key][0], -1]]));
export const resultCards = hand => Object.fromEntries(positions.map(key => [key, hand.cards[key].slice()]));
export const showdownTypes = hand => Object.fromEntries(positions.map(key => [key, evaluate(hand.cards[key]).cardType]));
export const outcome = hand => ({ winningAreas: hand.winningAreas.slice(), tieAreas: hand.tieAreas.slice(), lostAreas: hand.lostAreas.slice() });
export function betNet(hand, bet, odds) {
  if (hand.tieAreas.includes(bet.areaId)) return 0;
  if (!hand.winningAreas.includes(bet.areaId)) return -bet.total;
  return Number(BigInt(bet.total) * BigInt(Math.round(odds[bet.areaId] * 1000)) / 1000n);
}
export const resultFields = (_table, hand) => ({ blackJackAreaInfos: structuredClone(hand.blackJackAreaInfos) });
export function statistics(table) {
  const shoe = table.blackjackShoe;
  const dealCardCount = table.hand && table.state < phases.SHOWDOWN ? table.hand.shoeStart + 8 : shoe?.cursor || 0;
  return { totalCardsNum: 312, remainCardsNum: 312 - dealCardCount,
    cutIndex: shoe?.cutIndex ?? table.rules.cutIndex, collectCardCount: table.hand?.shoeStart ?? dealCardCount,
    dealCardCount, dealRealCount: dealCardCount };
}
export const roadSnapshot = table => table.ways;
export function updateRoads(table, hand) {
  const row = positions.slice(0, 3).map((_, i) => hand.tieAreas.includes(i + 1) ? 0 : hand.winningAreas.includes(i + 1) ? 1 : -1);
  const records = [...table.ways[2].ways, row].slice(-100);
  table.ways[1].ways = Object.fromEntries([1, 2, 3].map(id => [id, records.map(value => value[id - 1])]));
  table.ways[2].ways = records;
  positions.slice(0, 3).forEach((key, i) => { table.ways[2][key + 'WinCount'] = records.filter(value => value[i] === 1).length; });
}
// Bounded, reproducible fair development prices. Only exposed cards and the
// publicly known remaining shoe composition are used, never its secret order.
export function conditionalOdds(visible, pool = makeShoe(), samples = 2048) {
  if (!Number.isInteger(samples) || samples < 1 || samples > 16384) throw new Error('Invalid Blackjack pricing sample limit');
  const known = positions.map(key => visible[key + 'Cards']?.[0]);
  if (known.some(card => !Number.isInteger(card) || card < 0 || card > 51)) throw new Error('Invalid public Blackjack cards');
  const counts = Array(52).fill(0);
  for (const card of pool) {
    if (!Number.isInteger(card) || card < 0 || card > 51 || ++counts[card] > 6) throw new Error('Invalid Blackjack pricing shoe');
  }
  for (const card of known) if (--counts[card] < 0) throw new Error('Missing public Blackjack card');
  const deck = counts.flatMap((n, card) => Array(n).fill(card));
  if (deck.length < 16) throw new Error('Insufficient Blackjack pricing shoe');
  let seed = 2166136261;
  for (const n of [...known, ...counts]) seed = Math.imul(seed ^ (n + 1), 16777619) >>> 0;
  const rng = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const wins = [0, 0, 0], losses = [0, 0, 0];
  for (let n = 0; n < samples; n++) {
    const remaining = deck.slice(); let cursor = 0;
    const draw = () => { const i = cursor + Math.floor(rng() * (remaining.length - cursor));
      [remaining[i], remaining[cursor]] = [remaining[cursor], remaining[i]]; return remaining[cursor++]; };
    const hands = known.map(card => [card, draw()]);
    hands.forEach(cards => complete(cards, draw));
    for (let i = 0; i < 3; i++) { const result = compare(hands[i], hands[3]);
      if (result > 0) wins[i]++; else if (result < 0) losses[i]++; }
  }
  const odds = {};
  wins.forEach((count, i) => { odds[i + 1] = Math.floor((losses[i] + 0.5) / (count + 0.5) * 1000) / 1000;
    odds[i + 4] = Math.floor((count + 0.5) / (losses[i] + 0.5) * 1000) / 1000; });
  return odds;
}
export function prepareRound(table, hand) {
  hand.areaOdds = conditionalOdds(visibleCards(hand), hand.pricingPool);
  table.rules.betAreaOdds = { ...hand.areaOdds };
  delete hand.pricingPool;
}
export function beforeRound(table, io, now, rng) {
  const shoe = table.blackjackShoe;
  if (shoe && shoe.cursor < shoe.cutIndex && shoe.cards.length - shoe.cursor >= 20) return false;
  newShoe(table, rng);
  if (!shoe) return false;
  table.state = phases.SHUFFLING; table.phaseEndsAt = now + 3000;
  io.broadcast(PUSH.SHUFFLING_POKERS, { roomType: table.roomType, roomId: table.roomId,
    ...statistics(table), cardColor: table.inning % 2 });
  return true;
}
export const validateBet = (_table, totals) => [1, 2, 3].every(id => !(totals.get(id) > 0 && totals.get(id + 3) > 0));
export default { areaIds, phases, createHand, visibleCards, resultCards, showdownTypes, outcome,
  resultFields, personalResult: true, statistics, roadSnapshot, updateRoads, prepareRound, beforeRound, validateBet, betNet,
  dealSeconds: 4, stopSeconds: 1, compareSeconds: 5,
  revealSeconds: table => 5 + table.hand.blackJackAreaInfos.reduce((n, info) => n + info.supplySteps.length, 0) * 1.2,
  emptyCards: () => Object.fromEntries(positions.map(key => [key + 'Cards', [-1, -1]])),
  visibleShowdown: visible => Object.fromEntries(positions.map(key => [key, visible[key + 'Cards']])),
  snapshotCards: visible => visible,
};
