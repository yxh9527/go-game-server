import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { makeDeck, shuffle, evaluate7, compareRank } = await rel(import.meta.url, '../holdem/cards.js', v);
const areaIds = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
export function roadSnapshot(table) {
  // Migrate display metadata only; do not replace a resident hand or its bets.
  if (Array.isArray(table.ways?.[1])) {
    table.ways = { 1: { max: 100, ways: table.ways[1].slice().reverse().map(row =>
      row.winner === 'player' ? 1 : row.winner === 'banker' ? -1 : 0) },
      2: { max: 33, ways: [] }, 3: { max: 5, ways: [0, 0, 0, 0, 0] } };
  }
  return table.ways;
}

function rankCode(rank) {
  return { ROYAL_FLUSH: 9, STRAIGHT_FLUSH: 8, FOUR: 7, FULL_HOUSE: 6,
    FLUSH: 5, STRAIGHT: 4, TRIPS: 3, TWO_PAIR: 2, PAIR: 1, HIGH: 0 }[rank.name] ?? 0;
}

export function createHand(table, rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const banker = deck.slice(0, 2), player = deck.slice(2, 4), board = deck.slice(4, 9);
  const bankerRank = evaluate7([...banker, ...board]);
  const playerRank = evaluate7([...player, ...board]);
  const compare = compareRank(playerRank, bankerRank);
  const boardRank = evaluate7(board);
  const boardPlays = compare === 0 && compareRank(boardRank, bankerRank) === 0;
  const winner = boardPlays ? "board" : compare > 0 ? "player" : compare < 0 ? "banker" : "tie";
  const winningAreas = winner === "player" ? [1] : winner === "banker" ? [2] : [1, 2];
  const winningRank = winner === "banker" ? bankerRank : playerRank;
  const type = rankCode(winningRank);
  if (type === 0) winningAreas.push(3);
  else if (type === 1) winningAreas.push(4);
  else if (type === 2) winningAreas.push(5);
  else if (type === 3) winningAreas.push(6);
  else winningAreas.push(7);
  return { banker, player, board, bankerRank, playerRank, boardRank, winner, winningAreas,
    dealt: deck.slice(0, 9), publicIndices: new Set(), createdAt: 0 };
}

export function visibleCards(hand, rules) {
  return {
    bankerCards: rules.privateCards ? hand.banker.slice() : [-1, -1],
    playerCards: rules.privateCards ? hand.player.slice() : [-1, -1],
    publicCards: hand.board.map((card, index) => index < rules.boardCards ? card : -1),
  };
}

export function resultCards(hand) {
  return {
    banker: hand.banker.slice(), board: hand.board.slice(), player: hand.player.slice(),
  };
}

function outcome(hand) {
  return { winningAreas: hand.winningAreas.slice(),
    tieAreas: hand.winner === 'tie' || hand.winner === 'board' ? [1, 2] : [],
    lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)) };
}

export function updateRoads(table, hand) {
  const ways = roadSnapshot(table);
  const type = (hand.winner === 'banker' ? hand.bankerRank : hand.playerRank).cardTypeId;
  ways[1].ways = [...ways[1].ways, hand.winner === 'player' ? 1 : hand.winner === 'banker' ? -1 : 0].slice(-100);
  ways[2].ways = [...ways[2].ways, type].slice(-33);
  table.typeHistory = [...(table.typeHistory || []), Math.min(type, 5)].slice(-100);
  const stats = [1, 2, 3, 4, 5].map(id => Math.round(100 * table.typeHistory.filter(t => t === id).length / table.typeHistory.length));
  ways[3].ways = stats;
  table.boardTypeStats = Object.fromEntries(stats.map((value, i) => [i + 1, value]));

}
export const showdownTypes = hand => ({ banker: hand.bankerRank.cardTypeId, player: hand.playerRank.cardTypeId, board: hand.boardRank.cardTypeId });
export default { areaIds, createHand, visibleCards, resultCards, showdownTypes, roadSnapshot, updateRoads, outcome, emptyCards: () => ({ bankerCards: [-1, -1], playerCards: [-1, -1], publicCards: [-1, -1, -1, -1, -1] }), visibleShowdown: visible => ({banker: visible.bankerCards, player: visible.playerCards, board: visible.publicCards}) };
