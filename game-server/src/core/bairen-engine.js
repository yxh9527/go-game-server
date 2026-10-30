import { rel } from '../rel.js';
import { env } from '../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { credit, debit } = await rel(import.meta.url, '../wallet/index.js', v);
const { PUSH } = await rel(import.meta.url, '../messages.js', v);
const { hundredWalletContext } = await rel(import.meta.url, './robot.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../cache/game-server/hundred-history.js', v) : null;

export const PHASE = Object.freeze({ IDLE: 0, DEALING: 1, BETTING: 2, SHOWDOWN: 4, SETTLING: 5, STATS: 6, ENDED: 7 });
const defaultPhases = PHASE;
export function createBairenEngine(adapter) {
  const PHASE = adapter.phases || defaultPhases;
  function historyList(table, uid) {
    return history?.list(table, uid) || { gameRoomId: table.roomId, list: [] };
  }

  function historyDetail(table, uid, inning) {
    return history?.detail(table, uid, inning) || null;
  }

  const { areaIds, createHand, visibleCards, resultCards, roadSnapshot, outcome } = adapter;
  const numericOdds = table => table.hand?.areaOdds || table.rules.betAreaOdds;
  const emptyTotals = () => Object.fromEntries(areaIds.map(id => [id, 0]));
  const safeMoney = value => Number.isSafeInteger(value) && value > 0;

  // Snapshots and multi-bet cards use objects; the main-table 6212 uses numbers.
  function configuredOdds(table) {
    return Object.fromEntries(areaIds.map(id => [id, { id, odds: numericOdds(table)[id] }]));
  }

  function betAreaTotals(table) {
    return Object.fromEntries(areaIds.map(id => [id, table.totalBetsByArea?.[id] || 0]));
  }

  function roomSnapshot(table, session) {
    const hand = table.hand;
    const myBets = table.playerBets.get(Number(session.userId)) || [];
    const ownBets = Object.fromEntries(myBets.map(row => [row.areaId, { ...row }]));
    const now = Date.now();
    const visible = hand ? visibleCards(hand, table.rules) : null;
    const personal = adapter.personalResult ? hand?.settlements?.get(Number(session.userId)) : null;
    return {
      roomType: table.roomType, roomId: table.roomId, playMode: table.rules.playMode,
      state: table.state, inning: table.inning, playerId: Number(session.userId),
      playerNum: table.people, points: session.wallet, realScore: 0,
      countDown: Math.max(0, table.phaseEndsAt - now),
      totalBetsByArea: betAreaTotals(table), betAreaIds: Object.keys(ownBets).map(Number), ownBets,
      hundredParams: { gameName: table.rules.gameName, gameRoomConfigId: table.rules.gameRoomConfigId,
        maxBet: table.rules.maxBet, betAreaOdds: configuredOdds(table) },
      areaOdds: numericOdds(table), ways: roadSnapshot(table), boardTypeStats: table.boardTypeStats,
      ...adapter.statistics?.(table),
      systemInningScore: table.systemInningScore || 0, systemTodayTotalScore: table.systemTodayTotalScore || 0,
      winType: 0, waitingNextRound: table.state >= PHASE.SETTLING ? Math.max(0, table.phaseEndsAt - now) : 0,
      consecutiveWinCounts: table.consecutiveWinCounts || {}, maintenance: false, forcedWin: false,
      cardColor: table.cardColor, dealPokers: hand ? visibleCards(hand, table.rules) : adapter.emptyCards(),
      ...(adapter.snapshotCards?.(hand ? visible : adapter.emptyCards()) || {}),
      ...(hand && table.state >= PHASE.DEALING && table.state < PHASE.SHOWDOWN ? {
        showdownPokers: adapter.visibleShowdown(visible) } : {}),
      ...(hand && table.state >= PHASE.SHOWDOWN ? { showdownPokers: resultCards(hand), showdownTypes: adapter.showdownTypes(hand),
        ...outcome(hand), ...adapter.resultFields?.(table, hand), areaWinningScores: {},
        ...(personal ? { areaWinningScores: personal.areaWinningScores, realScore: personal.realScore } : {}) } : {}),
      customData: 2,
    };
  }

  function pushRoomState(io, table, extra = {}) {
    const payload = { roomType: table.roomType, roomId: table.roomId, inning: table.inning,
      // The original multi-bet model drops updates without its context tag.
      customData: 2,
      state: table.state, countDown: Math.max(0, table.phaseEndsAt - Date.now()),
      areaOdds: configuredOdds(table), totalBetsByArea: betAreaTotals(table), ways: roadSnapshot(table),
      cardColor: table.cardColor, ...adapter.statistics?.(table), ...extra };
    io.broadcast(PUSH.MB_SNC_ROOM_STATE, payload);
    io.broadcast(PUSH.GAME_STATE, { state: table.state, inning: table.inning, roomType: table.roomType,
      roomId: table.roomId, ways: roadSnapshot(table), cardColor: table.cardColor, ...adapter.statistics?.(table),
      systemInningScore: table.systemInningScore || 0, systemTodayTotalScore: table.systemTodayTotalScore || 0,
      countDown: Math.max(0, table.phaseEndsAt - Date.now()), consecutiveWinCounts: table.consecutiveWinCounts || {} });
  }

  function beginRound(io, table, now = Date.now(), rng = Math.random) {
    if (adapter.beforeRound?.(table, io, now, rng)) { pushRoomState(io, table); return; }
    table.hand = createHand(table, rng);
    table.hand.betReserveFactor = table.config.betBalanceFactor || 1;
    adapter.prepareRound?.(table, table.hand);
    table.hand.createdAt = now;
    table.state = adapter.startBetting ? PHASE.BETTING : PHASE.DEALING;
    table.phaseEndsAt = now + (adapter.startBetting ? table.config.betSeconds || 20 : adapter.dealSeconds || 1) * 1000;
    table.totalBetsByArea = emptyTotals();
    table.playerBets.clear();
    table.cardColor = table.inning % 2;
    const cards = visibleCards(table.hand, table.rules);
    io.broadcast(PUSH.DEAL_CARDS_AND_ODDS, { ...cards, areaOdds: numericOdds(table), roomType: table.roomType,
      playMode: table.rules.playMode, inning: table.inning, cardColor: table.cardColor });
    pushRoomState(io, table, { dealPokers: cards });
  }

  function acceptBet(ctx, body, responseId = 6201) {
    const { table, session, io } = ctx;
    const current = table.playerBets.get(Number(session.userId)) || [];
    const result = (code) => {
      const payload = { points: session.wallet, roomType: table.roomType, code, roomId: table.roomId, customData: Number(body?.customData ?? 2),
        myBets: current.map(row => ({ ...row })), myTotalBets: current.map(row => ({ ...row })),
        betAreaIds: current.map(row => row.areaId) };
      io.sendUser?.(session.userId, responseId, payload);
    };
    if (table.hand?.cancelTask || table.state !== PHASE.BETTING || Number(body.roomType) !== Number(table.roomType)
      || (body.roomId != null && Number(body.roomId) !== Number(table.roomId))) {
      result(1);
      return false;
    }
    const params = Array.isArray(body.params) ? body.params : [];
    const normalized = [];
    for (const row of params) {
      const areaId = Number(row?.areaId), total = Number(row?.total);
      if (!areaIds.includes(areaId) || !safeMoney(total) || total < table.rules.minBet
        || total > table.rules.maxBet
        || (table.config.rejectZeroOdds && !(numericOdds(table)[areaId] > 0))) {
        result(1);
        return false;
      }
      normalized.push({ areaId, total });
    }
    const requested = normalized.reduce((sum, row) => sum + row.total, 0);
    const byArea = new Map(current.map(row => [row.areaId, row.total]));
    for (const row of normalized) byArea.set(row.areaId, (byArea.get(row.areaId) || 0) + row.total);
    if (adapter.validateBet && (Date.now() >= table.phaseEndsAt || !adapter.validateBet(table, byArea))) {
      result(1); return false;
    }
    const balanceFactor = table.hand?.betReserveFactor || table.config.betBalanceFactor || 1;
    if (!normalized.length || !Number.isSafeInteger(requested)
      || !Number.isSafeInteger(requested * balanceFactor) || requested * balanceFactor > session.wallet) {
      result(1);
      return false;
    }
    if ([...byArea.values()].some(total => !Number.isSafeInteger(total) || total > table.rules.maxBet)) {
      result(1);
      return false;
    }
    const debited = debit(session, requested * balanceFactor, ctx);
    if (!debited?.ok) { result(1); return false; }
    for (const row of normalized) {
      const existing = current.find(item => item.areaId === row.areaId);
      if (existing) existing.total += row.total;
      else current.push({ ...row });
      table.totalBetsByArea[row.areaId] = (table.totalBetsByArea[row.areaId] || 0) + row.total;
    }
    table.playerBets.set(Number(session.userId), current);
    const own = current.map(row => ({ ...row }));
    io.broadcast(PUSH.BET_BROADCAST, { roomType: table.roomType, roomId: table.roomId,
      allPlayerBets: areaIds.map(areaId => ({ areaId, total: table.totalBetsByArea[areaId] })) });
    const payload = { points: session.wallet, roomType: table.roomType, code: 0, myBets: own,
      myTotalBets: own, betAreaIds: own.map(row => row.areaId), roomId: table.roomId, customData: Number(body?.customData ?? 2) };
    io.sendUser?.(session.userId, responseId, payload);
    return true;
  }

  async function cancelBets(ctx, body = {}) {
    const { table, session, io } = ctx;
    const uid = Number(session.userId), hand = table.hand;
    const respond = (code, canceledIds = []) => io.sendUser?.(uid, 6211, { code, areaIds: canceledIds,
      roomType: table.roomType, roomId: table.roomId, points: session.wallet,
      myBets: table.playerBets.get(uid) || [], myTotalBets: table.playerBets.get(uid) || [],
      betAreaIds: (table.playerBets.get(uid) || []).map(b => b.areaId) });
    if (!hand || hand.cancelTask || hand.settling || table.state !== PHASE.BETTING
      || Date.now() >= table.phaseEndsAt || Number(body.roomType) !== Number(table.roomType)
      || body.roomId != null && Number(body.roomId) !== Number(table.roomId)
      || !Array.isArray(body.areaIds) || body.areaIds.some(id => !areaIds.includes(Number(id)))) {
      respond(100085); return true;
    }
    const ids = new Set(body.areaIds.map(Number)), current = table.playerBets.get(uid) || [];
    const canceled = current.filter(b => ids.has(b.areaId));
    const refund = canceled.reduce((sum, bet) => sum + bet.total * (hand.betReserveFactor || 1), 0);
    if (!refund) { respond(0); return true; }
    const serial = hand.cancelSerial = (hand.cancelSerial || 0) + 1;
    // Block phase advancement until wallet and aggregate bets agree.
    const task = Promise.resolve().then(async () => {
      const result = await credit(session, refund, hundredWalletContext(ctx, session),
        { key: 'hundred-cancel:' + table.agentId + ':' + table.roomId + ':' + table.inning + ':' + uid + ':' + serial });
      if (result?.ok === false) { respond(100085); return; }
      table.playerBets.set(uid, current.filter(b => !ids.has(b.areaId)));
      for (const bet of canceled) table.totalBetsByArea[bet.areaId] -= bet.total;
      respond(0, canceled.map(b => b.areaId));
      io.broadcast(PUSH.BET_BROADCAST, { roomType: table.roomType, roomId: table.roomId,
        allPlayerBets: areaIds.map(areaId => ({ areaId, total: table.totalBetsByArea[areaId] })) });
    }).finally(() => { hand.cancelTask = null; });
    hand.cancelTask = task;
    await task;
    return true;
  }

  function resultForBets(table, bets) {
    const scores = {};
    let net = 0;
    for (const bet of bets || []) {
      const won = table.hand.winningAreas.includes(bet.areaId);
      const tied = table.hand.tieAreas.includes(bet.areaId);
      const odds = Number(numericOdds(table)[bet.areaId]) || 0;
      const payout = won && !tied ? Math.floor(bet.total * odds) : 0;
      scores[bet.areaId] = adapter.betNet ? adapter.betNet(table.hand, bet, numericOdds(table))
        : tied ? 0 : won ? payout : -bet.total;
      net += scores[bet.areaId];
    }
    return { net, scores };
  }

  async function settleRound(ctx) {
    const { table, io } = ctx;
    if (!table.hand || table.hand.cancelTask || table.hand.settled || table.hand.settling) return false;
    const hand = table.hand;
    hand.settling = true;
    try {
      hand.tieAreas = outcome(hand).tieAreas;
      const rankTypes = adapter.showdownTypes(hand);
      const cards = resultCards(hand);
      const extraResult = adapter.resultFields?.(table, hand) || {};
      const lostAreas = outcome(hand).lostAreas;
      if (!hand.roadsUpdated) {
        adapter.updateRoads(table, hand);
        hand.roadsUpdated = true;
      }
      const ways = roadSnapshot(table);
      const settlements = hand.settlements ||= new Map();
      table.systemInningScore = 0;
      for (const [uid, bets] of table.playerBets) {
        const session = table.playerSessions.get(uid) || io.sessionFor?.(uid);
        if (!session) continue;
        const { net, scores } = resultForBets(table, bets);
        table.systemInningScore -= net;
        const reserved = bets.reduce((sum, bet) => sum + bet.total * (hand.betReserveFactor || 1), 0);
        const payout = reserved + net;
        if (!Number.isSafeInteger(payout) || payout < 0) throw new Error('Invalid hundred settlement payout for user ' + uid);
        if (!settlements.has(Number(uid))) {
          if (payout > 0) {
            const paid = await credit(session, payout, hundredWalletContext(ctx, session),
              { key: 'bairen:' + table.agentId + ':' + table.roomType + ':' + table.roomId + ':' + table.inning + ':' + uid });
            if (paid?.ok === false) throw new Error('Hundred settlement credit rejected for user ' + uid);
          }
          settlements.set(Number(uid), { areaWinningScores: scores, realScore: net, points: session.wallet });
        }
        io.sendUser?.(uid, PUSH.PLAYER_BALANCE_UPDATE, { points: session.wallet });
      }
      table.hundredSettledInning = table.inning;
      hand.settled = true;
      const viewers = new Map();
      io.forEachPlayer?.(session => viewers.set(Number(session.userId), session));
      for (const [uid, session] of table.playerSessions) viewers.set(Number(uid), session);
      history?.record(table, { showdownPokers: cards, showdownTypes: rankTypes,
        winAreaIds: hand.winningAreas.slice(), tieAreaIds: hand.tieAreas.slice(),
        lostAreaIds: lostAreas, ...extraResult }, viewers, settlements);
      for (const [uid, session] of viewers) {
        const result = settlements.get(uid) || { areaWinningScores: {}, realScore: 0, points: session.wallet };
        if (adapter.personalResult) io.sendUser?.(uid, PUSH.SHOWDOWN_POKERS, {
          roomType: table.roomType, roomId: table.roomId, inning: table.inning,
          showdownPokers: cards, showdownTypes: rankTypes, ...outcome(hand), ...extraResult,
          ...result, ways, ...adapter.statistics?.(table), winType: 0 });
        io.sendUser?.(uid, PUSH.MB_ROOM_BET_SETTLE, { roomType: table.roomType, roomId: table.roomId, inning: table.inning,
          showdownPokers: cards, showdownTypes: rankTypes, winningAreas: hand.winningAreas,
          tieAreas: hand.tieAreas,
          lostAreas, ...extraResult, ...result,
          ways, ...adapter.statistics?.(table), winType: 0, boardTypeStats: table.boardTypeStats, customData: 2 });
      }
      table.systemTodayTotalScore = (table.systemTodayTotalScore || 0) + table.systemInningScore;
      for (const uid of table.playerSessions.keys()) {
        if (!table.visitors.has(uid)) table.playerSessions.delete(uid);
      }
      table.lastResult = { inning: table.inning, winningAreas: hand.winningAreas.slice(), winner: hand.winner };
      table.state = PHASE.SETTLING;
      table.phaseEndsAt = Date.now() + (adapter.settleSeconds || 3) * 1000;
      pushRoomState(io, table, { showdownPokers: cards, showdownTypes: rankTypes,
        winningAreas: hand.winningAreas });
      return true;
    } finally {
      hand.settling = false;
    }
  }

  function tick(io, table, now = Date.now(), ctx = {}) {
    if (table.hand?.cancelTask) return;
    if (PHASE.SHUFFLING != null && table.state === PHASE.SHUFFLING) {
      if (now < table.phaseEndsAt) return;
      table.state = PHASE.IDLE;
    }
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
      if (PHASE.STOP_BETTING != null) {
        table.state = PHASE.STOP_BETTING;
        table.phaseEndsAt = now + (adapter.stopSeconds || 1) * 1000;
        pushRoomState(io, table); return;
      }
    }
    if (table.state === PHASE.BETTING || (PHASE.STOP_BETTING != null && table.state === PHASE.STOP_BETTING)) {
      table.state = PHASE.SHOWDOWN;
      table.phaseEndsAt = now + (adapter.revealSeconds?.(table) || table.config.revealSeconds || 3) * 1000;
      const cards = resultCards(table.hand);
      io.broadcast(PUSH.SHOWDOWN_POKERS, { roomType: table.roomType, roomId: table.roomId, inning: table.inning,
        showdownPokers: cards, showdownTypes: adapter.showdownTypes(table.hand),
        ...outcome(table.hand), ...adapter.resultFields?.(table, table.hand),
        ways: roadSnapshot(table), ...adapter.statistics?.(table), winType: 0, points: -1, realScore: 0 });
      // The panel reads its open-card model immediately on GAME_STATE=4.
      pushRoomState(io, table, { showdownPokers: cards, showdownTypes: adapter.showdownTypes(table.hand) });
      return;
    }
    if (table.state === PHASE.SHOWDOWN) {
      if (PHASE.COMPARING != null) {
        table.state = PHASE.COMPARING;
        table.phaseEndsAt = now + (adapter.compareSeconds || 5) * 1000;
        pushRoomState(io, table); return;
      }
    }
    if (table.state === PHASE.SHOWDOWN || (PHASE.COMPARING != null && table.state === PHASE.COMPARING)) {
      const promise = settleRound({ ...ctx, table, io });
      promise?.catch?.(error => ctx.runtime?.log?.error("hundred settlement failed", error.message));
      return;
    }
    if (table.state === PHASE.SETTLING) {
      table.state = PHASE.STATS ?? PHASE.ENDED;
      table.phaseEndsAt = PHASE.STATS == null ? now : now + (table.config.nextRoundSeconds || 5) * 1000;
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
      if (adapter.phases) pushRoomState(io, table);
    }
  }

  return { PHASE, historyList, historyDetail, configuredOdds, roadSnapshot, createHand, visibleCards, resultCards, betAreaTotals, roomSnapshot, beginRound, acceptBet, cancelBets, settleRound, tick };
}
