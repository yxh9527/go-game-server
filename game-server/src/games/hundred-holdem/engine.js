import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { credit, debit } = await rel(import.meta.url, '../../wallet/index.js', v);
const { makeDeck, shuffle, evaluate7, compareRank } = await rel(import.meta.url, '../holdem/cards.js', v);
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { hundredWalletContext } = await rel(import.meta.url, '../../core/robot.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/hundred-holdem-history.js', v) : null;

export function historyList(table, uid) {
  return history?.list(table, uid) || { gameRoomId: table.roomId, list: [] };
}

export function historyDetail(table, uid, inning) {
  return history?.detail(table, uid, inning) || null;
}

export const PHASE = Object.freeze({ IDLE: 0, DEALING: 1, BETTING: 2, SHOWDOWN: 4, SETTLING: 5, STATS: 6, ENDED: 7 });
const areaIds = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const emptyTotals = () => Object.fromEntries(areaIds.map(id => [id, 0]));
const safeMoney = value => Number.isSafeInteger(value) && value > 0;

// Snapshots and multi-bet cards use objects; the main-table 6212 uses numbers.
export function configuredOdds(table) {
  return Object.fromEntries(areaIds.map(id => [id, { id, odds: table.rules.betAreaOdds[id] }]));
}

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

export function betAreaTotals(table) {
  return Object.fromEntries(areaIds.map(id => [id, table.totalBetsByArea?.[id] || 0]));
}

export function roomSnapshot(table, session) {
  const hand = table.hand;
  const myBets = table.playerBets.get(Number(session.userId)) || [];
  const ownBets = Object.fromEntries(myBets.map(row => [row.areaId, { ...row }]));
  const now = Date.now();
  const visible = hand ? visibleCards(hand, table.rules) : null;
  return {
    roomType: 50, roomId: table.roomId, playMode: table.rules.playMode,
    state: table.state, inning: table.inning, playerId: Number(session.userId),
    playerNum: table.people, points: session.wallet, realScore: 0,
    countDown: Math.max(0, table.phaseEndsAt - now),
    totalBetsByArea: betAreaTotals(table), betAreaIds: Object.keys(ownBets).map(Number), ownBets,
    hundredParams: { gameName: table.rules.gameName, gameRoomConfigId: table.rules.gameRoomConfigId,
      maxBet: table.rules.maxBet, betAreaOdds: configuredOdds(table) },
    areaOdds: table.rules.betAreaOdds, ways: roadSnapshot(table), boardTypeStats: table.boardTypeStats,
    systemInningScore: table.systemInningScore || 0, systemTodayTotalScore: table.systemTodayTotalScore || 0,
    winType: 0, waitingNextRound: table.state >= PHASE.SETTLING ? Math.max(0, table.phaseEndsAt - now) : 0,
    consecutiveWinCounts: {}, maintenance: false, forcedWin: false,
    cardColor: table.cardColor, dealPokers: hand ? visibleCards(hand, table.rules) : {
      bankerCards: [-1, -1], playerCards: [-1, -1], publicCards: [-1, -1, -1, -1, -1] },
    ...(hand && table.state >= PHASE.DEALING && table.state < PHASE.SHOWDOWN ? {
      showdownPokers: { banker: visible.bankerCards, player: visible.playerCards, board: visible.publicCards } } : {}),
    ...(hand && table.state >= PHASE.SHOWDOWN ? { showdownPokers: resultCards(hand), showdownTypes: {
      banker: hand.bankerRank.cardTypeId, player: hand.playerRank.cardTypeId,
      board: hand.boardRank.cardTypeId }, ...outcome(hand), areaWinningScores: {} } : {}),
    customData: 2,
  };
}

function outcome(hand) {
  return { winningAreas: hand.winningAreas.slice(),
    tieAreas: hand.winner === 'tie' || hand.winner === 'board' ? [1, 2] : [],
    lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)) };
}

function pushRoomState(io, table, extra = {}) {
  const payload = { roomType: 50, roomId: table.roomId, inning: table.inning,
    // The original multi-bet model drops updates without its context tag.
    customData: 2,
    state: table.state, countDown: Math.max(0, table.phaseEndsAt - Date.now()),
    areaOdds: configuredOdds(table), totalBetsByArea: betAreaTotals(table),
    cardColor: table.cardColor, ...extra };
  io.broadcast(PUSH.MB_SNC_ROOM_STATE, payload);
  io.broadcast(PUSH.GAME_STATE, { state: table.state, inning: table.inning, roomType: 50,
    roomId: table.roomId, ways: roadSnapshot(table), cardColor: table.cardColor,
    systemInningScore: table.systemInningScore || 0, systemTodayTotalScore: table.systemTodayTotalScore || 0 });
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
    const payload = { points: session.wallet, roomType: 50, code, roomId: table.roomId, customData: 2,
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
    myTotalBets: own, betAreaIds: own.map(row => row.areaId), roomId: table.roomId, customData: 2 };
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
  const ways = roadSnapshot(table);
  const type = (hand.winner === 'banker' ? hand.bankerRank : hand.playerRank).cardTypeId;
  ways[1].ways = [...ways[1].ways, hand.winner === 'player' ? 1 : hand.winner === 'banker' ? -1 : 0].slice(-100);
  ways[2].ways = [...ways[2].ways, type].slice(-33);
  table.typeHistory = [...(table.typeHistory || []), Math.min(type, 5)].slice(-100);
  const stats = [1, 2, 3, 4, 5].map(id => Math.round(100 * table.typeHistory.filter(t => t === id).length / table.typeHistory.length));
  ways[3].ways = stats;
  table.boardTypeStats = Object.fromEntries(stats.map((value, i) => [i + 1, value]));
  const settlements = new Map();
  table.systemInningScore = 0;
  for (const [uid, bets] of table.playerBets) {
    const session = table.playerSessions.get(uid) || io.sessionFor?.(uid);
    if (!session) continue;
    const { net, scores } = resultForBets(table, bets);
    table.systemInningScore -= net;
    const payout = bets.reduce((sum, bet) => sum + (hand.tieAreas.includes(bet.areaId) ? bet.total
      : hand.winningAreas.includes(bet.areaId) ? bet.total + Math.floor(bet.total
        * (Number(table.rules.betAreaOdds[bet.areaId]) || 0)) : 0), 0);
    if (payout > 0) await credit(session, payout, hundredWalletContext(ctx, session));
    settlements.set(Number(uid), { areaWinningScores: scores, realScore: net, points: session.wallet });
    io.sendUser?.(uid, PUSH.PLAYER_BALANCE_UPDATE, { points: session.wallet });
  }
  table.hundredSettledInning = table.inning;
  const viewers = new Map();
  io.forEachPlayer?.(session => viewers.set(Number(session.userId), session));
  for (const [uid, session] of table.playerSessions) viewers.set(Number(uid), session);
  history?.record(table, { showdownPokers: cards, showdownTypes: rankTypes,
    winAreaIds: hand.winningAreas.slice(), tieAreaIds: hand.tieAreas.slice(),
    lostAreaIds: areaIds.filter(id => !hand.winningAreas.includes(id)) }, viewers, settlements);
  for (const [uid, session] of viewers) {
    const result = settlements.get(uid) || { areaWinningScores: {}, realScore: 0, points: session.wallet };
    io.sendUser?.(uid, PUSH.MB_ROOM_BET_SETTLE, { roomType: 50, roomId: table.roomId, inning: table.inning,
      showdownPokers: cards, showdownTypes: rankTypes, winningAreas: hand.winningAreas,
      tieAreas: hand.tieAreas,
      lostAreas: areaIds.filter(id => !hand.winningAreas.includes(id)), ...result,
      ways, winType: 0, boardTypeStats: table.boardTypeStats, customData: 2 });
  }
  table.systemTodayTotalScore = (table.systemTodayTotalScore || 0) + table.systemInningScore;
  for (const uid of table.playerSessions.keys()) {
    if (!table.visitors.has(uid)) table.playerSessions.delete(uid);
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
    // Incremental BETTING starts the original card's fixed 20-second clock.
    // Read the current hot module config; resident rooms retain older objects.
    table.phaseEndsAt = now + (ctx.gameConfig?.betSeconds || table.config.betSeconds || 20) * 1000;
    pushRoomState(io, table, { dealPokers: visibleCards(table.hand, table.rules) });
    return;
  }
  if (table.state === PHASE.BETTING) {
    table.state = PHASE.SHOWDOWN;
    table.phaseEndsAt = now + (table.config.revealSeconds || 3) * 1000;
    const cards = resultCards(table.hand);
    io.broadcast(PUSH.SHOWDOWN_POKERS, { roomType: 50, roomId: table.roomId, inning: table.inning,
      showdownPokers: cards, showdownTypes: { banker: table.hand.bankerRank.cardTypeId,
        player: table.hand.playerRank.cardTypeId, board: table.hand.boardRank.cardTypeId },
      ...outcome(table.hand), ways: roadSnapshot(table), winType: 0, points: -1, realScore: 0 });
    // The panel reads its open-card model immediately on GAME_STATE=4.
    pushRoomState(io, table, { showdownPokers: cards, showdownTypes: {
      banker: table.hand.bankerRank.cardTypeId, player: table.hand.playerRank.cardTypeId,
      board: table.hand.boardRank.cardTypeId } });
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
