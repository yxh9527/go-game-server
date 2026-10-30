import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { makeDeck, shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { default: gameConfig } = await rel(import.meta.url, './config.js', v);
const { areaIds, point, winningAreas, netScore } = await rel(import.meta.url, './rules.js', v);
const pricing = await rel(import.meta.url, './odds.js', v);
const owner = await rel(import.meta.url, '../../core/hundred-table-owner.js', v);
const bankers = await rel(import.meta.url, '../../core/hundred-banker.js', v);
const history = await rel(import.meta.url, '../../core/hundred-card-history.js', v);
const { settleCardBets } = await rel(import.meta.url, '../../core/hundred-card-payout.js', v);

export function makeShoe(decks = 1) {
  if (decks !== 1) throw new Error('Dragon-tiger uses exactly one 52-card deck');
  return shuffle(makeDeck());
}
export function emptyAreas(odds = gameConfig.odds, mode = 0) {
  return areaIds(mode).map(areaId => ({ areaId, total: 0, oddsList: [Math.round(Number(odds[areaId] ?? 0) * 100)] }));
}
export function currentOdds(table) {
  const prices = table.preparedHand?.areaOdds || table.lastResult?.areaOdds
    || pricing.configuredOdds(table.config || gameConfig, table.playMode);
  // Native LHD reads decimal odds; the shared ledger keeps integer hundredths.
  // Project old resident hands too, without repricing or mutating frozen quotes.
  return Object.fromEntries(Object.entries(prices).map(([id, value]) =>
    [id, { ...value, odds: value.oddsList[0] / 100 }]));
}
export function roadSnapshot(table) {
  return { 1: { max: 180, ways: Array.isArray(table.ways[1]) ? table.ways[1] : table.ways[1]?.ways || [] },
    9: { type: 16384, roundNum: 0 } };
}
export function prepareHand(_io, table) {
  if (table.preparedHand) return table.preparedHand;
  if (table.deck.length - table.deckPos < 2) throw new Error('Dragon-tiger shoe must be shuffled before dealing');
  const dragon = table.deck[table.deckPos], tiger = table.deck[table.deckPos + 1];
  point(dragon); point(tiger);
  const areaOdds = table.playMode === 3 ? pricing.brightOdds(table.deck.slice(table.deckPos), dragon)
    : pricing.configuredOdds(table.config || gameConfig, table.playMode);
  table.preparedHand = { dragon, tiger, next: table.deckPos + 2, areaOdds };
  table.totalBetsByArea = emptyAreas(table.config.odds, table.playMode)
    .map(row => ({ ...row, total: table.totalBetsByArea.find(old => old.areaId === row.areaId)?.total || 0,
      oddsList: areaOdds[row.areaId].oddsList.slice() }));
  return table.preparedHand;
}
export function publicState(table) {
  return { remainCardsNum: table.remainCardsNum, cutIndex: table.cutIndex,
    collectCardCount: table.collectCardCount, dealCardCount: table.dealCardCount,
    dealRealCount: table.dealRealCount, supplyState: 1,
    ...(table.playMode === 3 && table.preparedHand ? {
      bankerShowPoker: [table.preparedHand.dragon], bankerCards: [table.preparedHand.dragon],
    } : {}) };
}
function resultPayload(table, result) {
  return { showdownPokers: result.showdownPokers, showdownTypes: result.showdownTypes,
    showdownPoints: { dragon: [result.d], tiger: [result.t] },
    lostAreas: areaIds(table.playMode).filter(id => !result.areas.includes(id)), ...owner.snapshot(table) };
}
export function roomConf(table) {
  const cfg = table.config || gameConfig;
  return { roomType: cfg.confRoomType, gameRoomConfigId: Number(table.cfg.game_room_config_id),
    playMode: table.playMode, roomIndex: table.roomIndex, hundredSwitch: false,
    brlhdParams: { gameName: cfg.modeNames[table.playMode], gameRoomConfigId: Number(table.cfg.game_room_config_id),
      maxBet: Number(table.cfg.hundred_max_bet ?? cfg.defaultMaxBet), roomIndex: table.roomIndex,
      betAreaOdds: currentOdds(table) } };
}
export function enterSnapshot(table, session) {
  const result = table.lastResult, uid = Number(session.userId), mine = table.playerBets.get(uid) || [];
  const params = roomConf(table).brlhdParams, payment = result?.settlements?.get(uid);
  return { roomType: table.roomType, roomId: table.roomId, playMode: table.playMode,
    roomIndex: table.roomIndex, inning: table.inning, state: table.state, playerId: uid,
    playerNum: table.people, points: session.wallet, realScore: payment?.realScore || 0,
    countDown: Math.max(0, (table.phaseEndsAt || 0) - Date.now()), totalCardsNum: 52,
    ...publicState(table), hundredParams: params, brlhdParams: params, areaOdds: currentOdds(table),
    totalBetsByArea: Object.fromEntries(table.totalBetsByArea.map(row => [row.areaId, row.total])),
    ownBets: Object.fromEntries(mine.map(bet => [bet.areaId, { ...bet }])), myBets: mine,
    betAreaIds: mine.map(bet => bet.areaId), cardColor: table.cardColor || 0, ways: roadSnapshot(table),
    systemInningScore: table.systemInningScore || 0, systemTodayTotalScore: table.systemTodayTotalScore || 0,
    ...owner.snapshot(table),
    ...(result ? { ...resultPayload(table, result), winningAreas: result.areas,
      areaWinningScores: payment?.areaWinningScores || {} } : {}) };
}
export function multiRoomSnapshot(table, session) {
  // Native HundredHaoluRoom treats any showdownPoints as Baccarat other/banker.
  // LHD must take its dragon/tiger showdownTypes branch on all multi-room paths.
  // Main-table owner peek still needs the original dragon/tiger point arrays.
  const { showdownPoints, ...snapshot } = enterSnapshot(table, session);
  return snapshot;
}
const needsShuffle = table => table.shuffleRequested || table.deckPos >= table.cutIndex || table.deck.length - table.deckPos < 2;
export function phasesFor(table) {
  const config = table.config || gameConfig, mode = table.playMode;
  const peek = mode === 4 && owner.snapshot(table).hostActive ? Math.max(0, owner.privilege(table).activePeekTime) * 2
    : [1, 3].includes(mode) ? config.peekSeconds : 0;
  return [
    ...(mode === 3 ? [{ state: 1, cycle: 1, seconds: 2 }] : []),
    { state: 2, cycle: 0, seconds: mode === 4 ? owner.privilege(table).activeBetTime : config.betSeconds[mode] },
    { state: 3, cycle: 3, seconds: 1 },
    { state: 4, cycle: 4, seconds: table.baccaratFlying ? 3 : peek + 5 },
    { state: 6, cycle: 6, seconds: config.settleSeconds },
    { state: 7, cycle: 7, seconds: 1 },
    { state: 8, cycle: 80, seconds: config.shuffleSeconds, skip: !needsShuffle(table) },
    { state: 0, cycle: 8, seconds: 1 },
  ];
}
export function migrateTable(table, config = gameConfig) {
  table.playMode ??= Number(table.cfg?.play_mode || 0);
  table.playerSessions ||= new Map(); table.visitors ||= new Set();
  if (table.hundredPhaseIndex != null && !table.hundredCycleTask
    && !(table.state === 6 && table.lastResult && !table.lastResult.settled)) {
    const phases = phasesFor(table);
    if (phases[table.hundredPhaseIndex]?.state !== table.state) {
      const index = phases.findIndex(phase => phase.state === table.state);
      if (index >= 0) table.hundredPhaseIndex = index;
    }
  }
}
export function applyCycle(io, table, cycle) {
  if ([0, 1].includes(cycle)) {
    table.state = cycle === 1 ? 1 : 2; prepareHand(io, table);
  } else if (cycle === 3) {
    table.state = 3;
    bankers.lock(table, table.preparedHand || prepareHand(io, table), table.config.bankerAreas, currentOdds(table));
    bankers.push(io, table, table.config.bankerAreas);
  } else if (cycle === 4) {
    table.state = 4;
    if (table.lastResult) return;
    const hand = table.preparedHand || prepareHand(io, table);
    const result = winningAreas(hand.dragon, hand.tiger, table.playMode);
    table.deckPos = hand.next; table.remainCardsNum = table.deck.length - table.deckPos;
    table.dealCardCount += 2; table.dealRealCount = table.dealCardCount;
    table.lastResult = { ...result, areaOdds: hand.areaOdds,
      showdownPokers: { dragon: [hand.dragon], tiger: [hand.tiger] },
      showdownTypes: { dragon: result.d, tiger: result.t } };
    table.shoeHands = (table.shoeHands || 0) + 1;
    table.ways[1] = [{ result: result.result, winArea: result.areas.slice() }, ...(table.ways[1] || [])].slice(0, 180);
    io.broadcast(PUSH.SHOWDOWN_POKERS, { roomId: table.roomId, roomType: table.roomType,
      ...resultPayload(table, table.lastResult), winningAreas: result.areas, realScore: 0, areaWinningScores: {},
      remainCardsNum: table.remainCardsNum, cutIndex: table.cutIndex });
  } else if (cycle === 6) {
    table.state = 6;
    const result = table.lastResult;
    if (!result) return;
    return result.settlementTask ||= settleCardBets(io, table, {
      calculate(table, result, mine) {
        const areaWinningScores = {}, betOdds = {}; let realScore = 0, stake = 0;
        for (const bet of mine) {
          const price = result.areaOdds[bet.areaId]?.oddsList[0];
          const net = netScore(bet, result, price);
          realScore += net; stake += bet.total; areaWinningScores[bet.areaId] = net; betOdds[bet.areaId] = price / 100;
        }
        return { realScore, areaWinningScores, betOdds, payout: stake + realScore, credited: false, notified: false };
      }, snapshot: multiRoomSnapshot, resultPayload, record: history.record, bankerAreas: table.config.bankerAreas,
    }).finally(() => { result.settlementTask = null; });
  } else if (cycle === 7) {
    table.state = 7; table.collectCardCount = table.dealCardCount;
  } else if (cycle === 80) {
    table.state = 8; table.deck = makeShoe(); table.deckPos = 0; table.remainCardsNum = 52;
    table.collectCardCount = table.dealCardCount = table.dealRealCount = 0;
    table.cardColor ^= 1; table.ways = { 1: [], 9: [] }; table.shoeHands = 0;
    table.shuffleRequested = false;
    io.broadcast(PUSH.SHUFFLING_POKERS, { roomId: table.roomId, roomType: table.roomType,
      cardColor: table.cardColor, cutIndex: table.cutIndex, card: -1, point: 0 });
  } else if (cycle === 8) {
    if (table.lastResult && !table.lastResult.settled) throw new Error('Cannot discard unsettled dragon-tiger bets');
    table.state = 0; table.inning++; table.preparedHand = null; table.lastResult = null;
    table.totalBetsByArea = emptyAreas(table.config.odds, table.playMode); table.playerBets.clear();
    table.baccaratFlying = false; owner.beforeRound(io, table);
  } else throw new Error('Unsupported dragon-tiger cycle');
}
