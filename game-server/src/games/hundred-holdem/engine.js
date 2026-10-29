import { credit, debit } from "../../wallet/index.js";
import { makeDeck, shuffle, evaluate7, compareRank } from "../holdem/cards.js";
import { PUSH } from "../../messages.js";

export const PHASE = Object.freeze({ IDLE: 0, DEALING: 1, BETTING: 2, SHOWDOWN: 4, SETTLING: 5, STATS: 6, ENDED: 7 });
const areaIds = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const emptyTotals = () => Object.fromEntries(areaIds.map(id => [id, 0]));
const safeMoney = value => Number.isSafeInteger(value) && value > 0;

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

export function betAreaTotals(table) {
  return Object.fromEntries(areaIds.map(id => [id, table.totalBetsByArea?.[id] || 0]));
}

export function roomSnapshot(table, session) {
  const hand = table.hand;
  const myBets = table.playerBets.get(Number(session.userId)) || [];
  const ownBets = Object.fromEntries(myBets.map(row => [row.areaId, row.total]));
  const now = Date.now();
  return {
    roomType: 50, roomId: table.roomId, playMode: table.rules.playMode,
    state: table.state, inning: table.inning, playerId: Number(session.userId),
    playerNum: table.people, points: session.wallet, realScore: 0,
    countDown: Math.max(0, table.phaseEndsAt - now),
    totalBetsByArea: betAreaTotals(table), betAreaIds: Object.keys(ownBets).map(Number), ownBets,
    hundredParams: { gameName: table.rules.gameName, gameRoomConfigId: table.rules.gameRoomConfigId,
      maxBet: table.rules.maxBet, betAreaOdds: table.rules.betAreaOdds },
    areaOdds: table.rules.betAreaOdds, ways: table.ways, boardTypeStats: table.boardTypeStats,
    cardColor: table.cardColor, dealPokers: hand ? visibleCards(hand, table.rules) : {
      bankerCards: [-1, -1], playerCards: [-1, -1], publicCards: [-1, -1, -1, -1, -1] },
    ...(hand && table.state >= PHASE.SHOWDOWN ? { showdownPokers: resultCards(hand), showdownTypes: {
      banker: hand.bankerRank.cardTypeId, player: hand.playerRank.cardTypeId,
      board: hand.boardRank.cardTypeId } } : {}),
    customData: 2,
  };
}

function pushRoomState(io, table, extra = {}) {
  const payload = { roomType: 50, roomId: table.roomId, inning: table.inning,
    state: table.state, countDown: Math.max(0, table.phaseEndsAt - Date.now()),
    areaOdds: table.rules.betAreaOdds, totalBetsByArea: betAreaTotals(table),
    cardColor: table.cardColor, ...extra };
  io.broadcast(PUSH.MB_SNC_ROOM_STATE, payload);
  io.broadcast(PUSH.GAME_STATE, { state: table.state, inning: table.inning, roomType: 50,
    roomId: table.roomId, ways: table.ways, cardColor: table.cardColor });
}

export function beginRound(io, table, now = Date.now(), rng = Math.random) {
  table.hand = createHand(table, rng);
  table.hand.createdAt = now;
  table.state = PHASE.DEALING;
  table.phaseEndsAt = now + 1000;
  table.totalBetsByArea = emptyTotals();
  table.playerBets.clear();
  table.cardColor = table.inning % 2;
  const cards = visibleCards(table.hand, table.rules);
  io.broadcast(PUSH.DEAL_CARDS_AND_ODDS, { ...cards, areaOdds: table.rules.betAreaOdds, roomType: 50,
    playMode: table.rules.playMode, inning: table.inning, cardColor: table.cardColor });
  pushRoomState(io, table, { dealPokers: cards });
}

export function acceptBet(ctx, body, responseId = 6201) {
  const { table, session, io } = ctx;
  const current = table.playerBets.get(Number(session.userId)) || [];
  const result = (code) => {
    const payload = { points: session.wallet, roomType: 50, code, roomId: table.roomId,
      myBets: current.map(row => ({ ...row })), myTotalBets: current.map(row => ({ ...row })),
      betAreaIds: current.map(row => row.areaId) };
    io.sendUser?.(session.userId, responseId, payload);
  };
  if (table.state !== PHASE.BETTING || Number(body.roomType) !== 50
    || (body.roomId != null && Number(body.roomId) !== Number(table.roomId))) {
    result(1);
    return false;
  }
  const params = Array.isArray(body.params) ? body.params : [];
  const normalized = [];
  for (const row of params) {
    const areaId = Number(row?.areaId), total = Number(row?.total);
    if (!areaIds.includes(areaId) || !safeMoney(total) || total < table.rules.minBet
      || total > table.rules.maxBet) {
      result(1);
      return false;
    }
    normalized.push({ areaId, total });
  }
  const requested = normalized.reduce((sum, row) => sum + row.total, 0);
  if (!normalized.length || !Number.isSafeInteger(requested) || requested > session.wallet) {
    result(1);
    return false;
  }
  const debited = debit(session, requested, ctx);
  if (!debited?.ok) { result(1); return false; }
  for (const row of normalized) {
    const existing = current.find(item => item.areaId === row.areaId);
    if (existing) existing.total += row.total;
    else current.push({ ...row });
    table.totalBetsByArea[row.areaId] = (table.totalBetsByArea[row.areaId] || 0) + row.total;
  }
  table.playerBets.set(Number(session.userId), current);
  const own = current.map(row => ({ ...row }));
  io.broadcast(PUSH.BET_BROADCAST, { roomType: 50, roomId: table.roomId,
    allPlayerBets: areaIds.map(areaId => ({ areaId, total: table.totalBetsByArea[areaId] })) });
  const payload = { points: session.wallet, roomType: 50, code: 0, myBets: own,
    myTotalBets: own, betAreaIds: own.map(row => row.areaId), roomId: table.roomId };
  io.sendUser?.(session.userId, responseId, payload);
  return true;
}

function resultForBets(table, bets) {
  const scores = {};
  let net = 0;
  for (const bet of bets || []) {
    const won = table.hand.winningAreas.includes(bet.areaId);
    const tied = table.hand.tieAreas.includes(bet.areaId);
    const odds = Number(table.rules.betAreaOdds[bet.areaId]) || 0;
    const payout = won && !tied ? Math.floor(bet.total * odds) : 0;
    scores[bet.areaId] = tied ? 0 : won ? payout : -bet.total;
    net += scores[bet.areaId];
  }
  return { net, scores };
}

export async function settleRound(ctx) {
  const { table, io } = ctx;
  if (!table.hand || table.hand.settled) return false;
  const hand = table.hand;
  hand.settled = true;
  hand.tieAreas = hand.winner === "tie" || hand.winner === "board" ? [1, 2] : [];
  const rankTypes = { banker: hand.bankerRank.cardTypeId, player: hand.playerRank.cardTypeId,
    board: hand.boardRank.cardTypeId };
  const cards = resultCards(hand);
  table.boardTypeStats[rankTypes.player] = (table.boardTypeStats[rankTypes.player] || 0) + 1;
  table.ways[1] = [{ inning: table.inning, winningAreas: hand.winningAreas.slice(), winner: hand.winner },
    ...(table.ways[1] || [])].slice(0, 100);
  const settlements = new Map();
  for (const [uid, bets] of table.playerBets) {
    const session = table.playerSessions.get(uid) || io.sessionFor?.(uid);
    if (!session) continue;
    const { net, scores } = resultForBets(table, bets);
    const payout = bets.reduce((sum, bet) => sum + (hand.tieAreas.includes(bet.areaId) ? bet.total
      : hand.winningAreas.includes(bet.areaId) ? bet.total + Math.floor(bet.total
        * (Number(table.rules.betAreaOdds[bet.areaId]) || 0)) : 0), 0);
    if (payout > 0) await credit(session, payout, ctx);
    settlements.set(Number(uid), { areaWinningScores: scores, realScore: net, points: session.wallet });
    io.sendUser?.(uid, PUSH.PLAYER_BALANCE_UPDATE, { points: session.wallet });
  }
  const viewers = new Map();
  io.forEachPlayer?.(session => viewers.set(Number(session.userId), session));
  for (const [uid, session] of table.playerSessions) viewers.set(Number(uid), session);
  for (const [uid, session] of viewers) {
    const result = settlements.get(uid) || { areaWinningScores: {}, realScore: 0, points: session.wallet };
    io.sendUser?.(uid, PUSH.MB_ROOM_BET_SETTLE, { roomType: 50, roomId: table.roomId, inning: table.inning,
      showdownPokers: cards, showdownTypes: rankTypes, winningAreas: hand.winningAreas,
      tieAreas: hand.tieAreas,
      lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)), ...result,
      boardTypeStats: table.boardTypeStats, customData: 2 });
  }
  table.lastResult = { inning: table.inning, winningAreas: hand.winningAreas.slice(), winner: hand.winner };
  table.state = PHASE.SETTLING;
  table.phaseEndsAt = Date.now() + 3000;
  pushRoomState(io, table, { showdownPokers: cards, showdownTypes: rankTypes,
    winningAreas: hand.winningAreas });
  return true;
}

export function tick(io, table, now = Date.now(), ctx = {}) {
  if (!table.hand) { beginRound(io, table, now); return; }
  if (now < table.phaseEndsAt) return;
  if (table.state === PHASE.DEALING) {
    table.state = PHASE.BETTING;
    table.phaseEndsAt = now + (table.config.betSeconds || 15) * 1000;
    pushRoomState(io, table, { dealPokers: visibleCards(table.hand, table.rules) });
    return;
  }
  if (table.state === PHASE.BETTING) {
    table.state = PHASE.SHOWDOWN;
    table.phaseEndsAt = now + (table.config.revealSeconds || 3) * 1000;
    const cards = resultCards(table.hand);
    pushRoomState(io, table, { showdownPokers: cards, showdownTypes: {
      banker: table.hand.bankerRank.cardTypeId, player: table.hand.playerRank.cardTypeId,
      board: table.hand.boardRank.cardTypeId } });
    io.broadcast(PUSH.SHOWDOWN_POKERS, { roomType: 50, roomId: table.roomId, inning: table.inning,
      showdownPokers: cards, winningAreas: table.hand.winningAreas });
    return;
  }
  if (table.state === PHASE.SHOWDOWN) {
    const promise = settleRound({ ...ctx, table, io });
    promise?.catch?.(error => ctx.runtime?.log?.error("hundred holdem settlement failed", error.message));
    return;
  }
  if (table.state === PHASE.SETTLING) {
    table.state = PHASE.STATS;
    table.phaseEndsAt = now + (table.config.nextRoundSeconds || 5) * 1000;
    pushRoomState(io, table);
    return;
  }
  if (table.state === PHASE.STATS) {
    table.state = PHASE.ENDED;
    table.phaseEndsAt = now;
    pushRoomState(io, table);
    return;
  }
  if (table.state === PHASE.ENDED) {
    table.inning += 1;
    table.hand = null;
    table.state = PHASE.IDLE;
    table.phaseEndsAt = now;
    table.totalBetsByArea = emptyTotals();
    table.playerBets.clear();
  }
}
