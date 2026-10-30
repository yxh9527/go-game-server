import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { makeDeck, shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { evaluate3, compareWithSuit } = await rel(import.meta.url, '../zjh/hand.js', v);
export const areaIds = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);

export function special235(rank) {
  return rank.cardTypeId === 1 && rank.key.join(',') === '5,3,2';
}

export function compareHands(red, black) {
  if (special235(red) && black.cardTypeId === 6) return 1;
  if (special235(black) && red.cardTypeId === 6) return -1;
  return compareWithSuit(red, black);
}

export function createHand(_table, rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const red = deck.slice(0, 3), black = deck.slice(3, 6);
  const redRank = evaluate3(red), blackRank = evaluate3(black);
  const winner = compareHands(redRank, blackRank) > 0 ? 'hong' : 'hei';
  const winningType = (winner === 'hong' ? redRank : blackRank).cardTypeId;
  return { red, black, redRank, blackRank, winner, winningType,
    winningAreas: [winner === 'hong' ? 1 : 2, winningType + 2],
    dealt: deck.slice(0, 6), publicIndices: new Set(), createdAt: 0 };
}

export function visibleCards(hand, rules) {
  return { bankerCards: hand.red.map((card, i) => i < rules.redCards ? card : -1),
    playerCards: hand.black.map((card, i) => i < rules.blackCards ? card : -1) };
}

export const resultCards = hand => ({ hong: hand.red.slice(), hei: hand.black.slice() });
export const showdownTypes = hand => ({ hong: hand.redRank.cardTypeId, hei: hand.blackRank.cardTypeId });
export const outcome = hand => ({ winningAreas: hand.winningAreas.slice(), tieAreas: [],
  lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)) });

export function roadSnapshot(table) { return table.ways; }

export function updateRoads(table, hand) {
  const record = { heiHong: hand.winner === 'hong', paiXing: hand.winningType };
  table.ways[1].ways = [...table.ways[1].ways, record].slice(-100);
}

let rankedHands;
function candidates() {
  if (rankedHands) return rankedHands;
  const result = [];
  for (let a = 0; a < 50; a++) for (let b = a + 1; b < 51; b++) for (let c = b + 1; c < 52; c++) {
    const cards = [a, b, c], rank = evaluate3(cards);
    const ordered = cards.slice().sort((x, y) => {
      const score = card => {
        let value = card % 13 === 0 ? 14 : card % 13 + 1;
        if ([3, 5].includes(rank.cardTypeId) && rank.key[0] === 3 && value === 14) value = 1;
        if (rank.cardTypeId === 2 && value === rank.key[0]) value += 20;
        return value * 4 + Math.floor(card / 13);
      };
      return score(y) - score(x);
    });
    const strength = [rank.cardTypeId, rank.key[0] || 0, rank.key[1] || 0, rank.key[2] || 0,
      ...ordered.map(card => Math.floor(card / 13))].reduce((n, value) => n * 15 + value, 0);
    result.push({ cards, strength, type: rank.cardTypeId, bucket: special235(rank) ? 7 : rank.cardTypeId });
  }
  return rankedHands = result.sort((a, b) => a.strength - b.strength);
}

function frequencies() {
  const totals = new Float64Array(8), singles = new Float64Array(8 * 52), pairs = new Float64Array(8 * 2704);
  const triples = new Map();
  return {
    add(row) {
      const { bucket: group, unknown } = row;
      totals[group]++;
      for (let i = 0; i < unknown.length; i++) {
        singles[group * 52 + unknown[i]]++;
        for (let j = i + 1; j < unknown.length; j++) pairs[group * 2704 + unknown[i] * 52 + unknown[j]]++;
      }
      if (unknown.length === 3) triples.set(unknown[0] * 2704 + unknown[1] * 52 + unknown[2], group);
    },
    disjoint(group, cards) {
      let count = totals[group];
      for (let i = 0; i < cards.length; i++) {
        count -= singles[group * 52 + cards[i]];
        for (let j = i + 1; j < cards.length; j++) count += pairs[group * 2704 + cards[i] * 52 + cards[j]];
      }
      if (cards.length === 3 && triples.get(cards[0] * 2704 + cards[1] * 52 + cards[2]) === group) count--;
      return count;
    },
  };
}

// Exact conditional enumeration using only public cards. Prefix counts with
// inclusion-exclusion avoid comparing every possible pair of three-card hands.
export function conditionalOutcomes(redKnown = [], blackKnown = []) {
  const known = [...redKnown, ...blackKnown];
  if (known.length !== new Set(known).size || redKnown.length > 3 || blackKnown.length > 3
    || known.some(card => !Number.isInteger(card) || card < 0 || card >= 52)) throw new Error('Invalid public cards');
  const available = (own, other) => candidates().filter(row => own.every(card => row.cards.includes(card))
    && !other.some(card => row.cards.includes(card))).map(row => ({ ...row, unknown: row.cards.filter(card => !own.includes(card)) }));
  const reds = available(redKnown, blackKnown), blacks = available(blackKnown, redKnown);
  const all = frequencies(), lower = frequencies();
  for (const row of blacks) all.add(row);
  const counts = Object.fromEntries(areaIds.map(id => [id, 0]));
  let cursor = 0, total = 0;
  for (const red of reds) {
    while (cursor < blacks.length && blacks[cursor].strength < red.strength) lower.add(blacks[cursor++]);
    for (let group = 1; group <= 7; group++) {
      const possible = all.disjoint(group, red.unknown);
      const redWins = red.bucket === 7 && group === 6 ? possible
        : red.bucket === 6 && group === 7 ? 0 : lower.disjoint(group, red.unknown);
      const blackWins = possible - redWins;
      total += possible; counts[1] += redWins; counts[2] += blackWins;
      counts[red.type + 2] += redWins;
      counts[(group === 7 ? 1 : group) + 2] += blackWins;
    }
  }
  return { total, counts };
}

export function prepareRound(table, hand) {
  const { total, counts } = conditionalOutcomes(hand.red.slice(0, table.rules.redCards), hand.black.slice(0, table.rules.blackCards));
  // Fair net odds, rounded down to the protocol's three-decimal precision.
  // No unconfirmed house edge is invented; production pricing needs approval.
  hand.areaOdds = Object.fromEntries(areaIds.map(id => [id, counts[id] > 0
    ? Math.floor((total - counts[id]) * 1000 / counts[id]) / 1000 : 0]));
  table.rules.betAreaOdds = { ...hand.areaOdds };
}

export default { areaIds, createHand, visibleCards, resultCards, showdownTypes,
  roadSnapshot, updateRoads, outcome, prepareRound,
  emptyCards: () => ({ bankerCards: [-1, -1, -1], playerCards: [-1, -1, -1] }),
  visibleShowdown: visible => ({ hong: visible.bankerCards, hei: visible.playerCards }),
  snapshotCards: visible => ({ bankerCards: visible.bankerCards, playerCards: visible.playerCards }),
};
