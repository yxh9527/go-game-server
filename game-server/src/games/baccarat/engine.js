import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { settleCardBets } = await rel(import.meta.url, '../../core/hundred-card-payout.js', v);
const { makeDeck, shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { baccaratValue, drawBaccarat, winningAreas, winningOdds, pointStages, supplyState } = await rel(import.meta.url, './rules.js', v);
const { default: gameConfig } = await rel(import.meta.url, './config.js', v);
const pricing = await rel(import.meta.url, './odds.js', v);
const history = await rel(import.meta.url, './history.js', v);
const owner = await rel(import.meta.url, './table-owner.js', v);
const bankers = await rel(import.meta.url, '../../core/hundred-banker.js', v);

export function migrateTable(table, config = gameConfig) {
  table.playMode ??= Number(table.cfg?.play_mode || 0);
  for (const [key, value] of Object.entries(config)) if (table.config[key] === undefined) table.config[key] = value;
  table.playerSessions ||= new Map(); table.visitors ||= new Set();
  if (table.hundredPhaseIndex != null && !table.hundredCycleTask
    && !(table.state === 6 && table.lastResult && !table.lastResult.settled)) {
    const phases = phasesFor(table);
    if (phases[table.hundredPhaseIndex]?.state !== table.state) {
      const index = phases.findIndex(p => p.state === table.state
        && (table.state !== 9 || p.cycle === (table.otherSupply ? 91 : 90)));
      if (index >= 0) table.hundredPhaseIndex = index;
    }
  }
}

function oddsMap(table) {
  return table.config?.odds || gameConfig.odds;
}

export function currentOdds(table) {
  return table.preparedHand?.areaOdds || table.lastResult?.areaOdds || pricing.configuredOdds(table.config || gameConfig);
}

export function roadSnapshot(table) {
  return { 1: Array.isArray(table.ways[1]) ? { max: 104, ways: table.ways[1] } : table.ways[1],
    9: Array.isArray(table.ways[9]) || !table.ways[9] ? { type: 16384, roundNum: 0 } : table.ways[9] };
}

export function prepareHand(io, table) {
  if (table.preparedHand) return table.preparedHand;
  const config = table.config || gameConfig;
  const cards = table.deck.slice(table.deckPos);
  if (cards.length < 6) throw new Error('Baccarat shoe must be shuffled before dealing');
  const dealt = drawBaccarat(table.deck, table.deckPos);
  const areaOdds = table.playMode === 3
    ? pricing.brightOdds(cards, { other: dealt.player[0], banker: dealt.banker[0] }, config)
    : pricing.configuredOdds(config);
  table.preparedHand = { ...dealt, start: table.deckPos, areaOdds };
  table.supplyState = 1; table.otherSupply = false;
  table.totalBetsByArea = table.totalBetsByArea.map(row => ({ ...row, oddsList: areaOdds[row.areaId].oddsList.slice() }));
  return table.preparedHand;
}

export function phasesFor(table) {
  const config = table.config || gameConfig, mode = table.playMode ?? Number(table.cfg?.play_mode || 0);
  const peek = mode === 3 ? config.brightPeekSeconds : config.peekSeconds;
  const phases = [
    // Six native deal tweens are spaced 0.75s apart. Betting must begin
    // after those cards and their new dynamic prices have reached the table.
    ...(mode === 3 ? [{ state: 1, cycle: 1, seconds: 5 }] : []),
    { state: 2, cycle: 0, seconds: mode === 4 ? owner.privilege(table).activeBetTime : config.betSeconds[mode] },
    { state: 3, cycle: 3, seconds: 1 },
    { state: 4, cycle: 4, seconds: mode === 2 || table.baccaratFlying ? 3
      : mode === 4 && owner.snapshot(table).hostActive && owner.privilege(table).activePeekTime > 0
        ? owner.privilege(table).activePeekTime * owner.betAreas(table).length + 3
        : mode === 1 || mode === 3 ? peek + 3 : 7 },
    ...(mode === 1 || mode === 3 || mode === 4 ? [
      { state: 9, cycle: 90, seconds: (mode === 3 ? config.brightPeekSeconds : mode === 4 ? Math.max(0, owner.privilege(table).activePeekTime) : config.supplyPeekSeconds) + 3,
        skip: table.supplyState === 1 || mode === 4 && (!owner.snapshot(table).hostActive || owner.privilege(table).activePeekTime < 0) },
      { state: 9, cycle: 91, seconds: (mode === 3 ? config.brightPeekSeconds : mode === 4 ? Math.max(0, owner.privilege(table).activePeekTime) : config.supplyPeekSeconds) + 3,
        skip: table.supplyState !== 3 || mode === 4 && (!owner.snapshot(table).hostActive || owner.privilege(table).activePeekTime < 0) },
    ] : []),
    { state: 6, cycle: 6, seconds: config.settleSeconds },
    { state: 7, cycle: 7, seconds: 1 },
    { state: 8, cycle: 80, seconds: config.shuffleSeconds, skip: !needsShuffle(table) },
    { state: 0, cycle: 8, seconds: 1 },
  ];
  return phases;
}

function needsShuffle(table) {
  return Boolean(table.shuffleRequested || table.deckPos >= table.cutIndex
    || table.deck.length - table.deckPos < (table.config?.reshuffleAt ?? 30));
}

function shuffleShoe(io, table) {
  table.deck = makeShoe(table.config?.decks || 8); table.deckPos = 0;
  const card = table.deck[0], point = baccaratValue(card) || 10;
  table.deckPos = point + 1;
  table.totalCardsNum = table.deck.length; table.remainCardsNum = table.deck.length - table.deckPos;
  table.collectCardCount = table.dealCardCount = table.dealRealCount = table.deckPos;
  table.ways = { 1: [], 9: [] }; table.cardColor = (table.cardColor || 0) ^ 1;
  table.shuffleRequested = false; table.shoeHands = 0; table.lastResult = null; table.preparedHand = null;
  io.broadcast(PUSH.SHUFFLING_POKERS, { roomType: table.roomType, roomId: table.roomId,
    cardColor: table.cardColor, cutIndex: table.cutIndex, card, point });
}

export function emptyAreas(odds) {
  return Array.from({ length: 9 }, (_, i) => ({ areaId: i + 1, total: 0, oddsList: oddsList(i + 1, odds) }));
}

function oddsList(areaId, odds) {
  if (gameConfig.sideOdds[areaId]) return gameConfig.sideOdds[areaId].map(n => Math.round(n * 100));
  const n = Math.round(((odds || gameConfig.odds)[areaId] || 1) * 100);
  return [n];
}

export function makeShoe(decks = 8) {
  const cards = [];
  for (let i = 0; i < decks; i += 1) {
    cards.push(...makeDeck());
  }
  return shuffle(cards);
}

export function createBaccaratTable(roomId, roomType, cfg, config = gameConfig) {
  const deck = makeShoe(config.decks);
  return {
    gameId: config.id,
    kind: config.kind,
    roomId: Number(roomId),
    roomType: Number(roomType) || config.roomTypes[0],
    cfg,
    config,
    state: 2,
    inning: 1,
    totalCardsNum: 416,
    remainCardsNum: 416,
    cutIndex: 326,
    collectCardCount: 0,
    dealCardCount: 0,
    dealRealCount: 0,
    supplyState: 1,
    totalBetsByArea: emptyAreas(config.odds),
    playerBets: new Map(),
    ways: { 1: [], 9: [] },
    people: 0,
    roomIndex: Number(cfg?.room_index || 1),
    tick: 0,
    deck,
    deckPos: 0,
    lastResult: null,
  };
}

export function baccaratConf(table) {
  const cfg = table.config || gameConfig;
  return {
    roomType: cfg.confRoomType,
    brbjlParams: {
      gameName: cfg.modeNames?.[Number(table.cfg?.play_mode || 0)] || cfg.gameName,
      gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
      maxBet: Number(table.cfg?.hundred_max_bet || cfg.defaultMaxBet),
      roomIndex: table.roomIndex,
      betAreaOdds: currentOdds(table),
    },
    hundredSwitch: false,
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
    playMode: Number(table.cfg?.play_mode || 0),
    roomIndex: table.roomIndex,
  };
}

export const roomConf = baccaratConf;
export function publicState(table) {
  return { supplyState: table.supplyState, remainCardsNum: table.remainCardsNum,
    cutIndex: table.cutIndex, collectCardCount: table.collectCardCount,
    dealCardCount: table.dealCardCount, dealRealCount: table.dealRealCount,
    otherSupply: Boolean(table.otherSupply),
    ...(table.playMode === 3 && table.preparedHand ? {
      otherShowPoker: [table.preparedHand.player[0]], bankerShowPoker: [table.preparedHand.banker[0]],
    } : {}) };
}

export function enterSnapshot(table, session) {
  const conf = baccaratConf(table), mine = table.playerBets.get(Number(session.userId)) || [];
  const betAreaOdds = currentOdds(table);
  const result = table.state >= 4 ? table.lastResult : null;
  return {
    roomType: table.roomType,
    state: table.state,
    roomId: table.roomId,
    inning: table.inning,
    playerId: Number(session.userId),
    playMode: Number(table.cfg?.play_mode || 0), roomIndex: table.roomIndex,
    countDown: Math.max(0, (table.phaseEndsAt || Date.now() + 25000) - Date.now()),
    hundredParams: { ...conf.brbjlParams, betAreaOdds }, areaOdds: betAreaOdds,
    ownBets: Object.fromEntries(mine.map(bet => [bet.areaId, { ...bet }])),
    cardColor: table.cardColor || 0, playerNum: table.people,
    realScore: result?.settlements?.get(Number(session.userId))?.realScore || 0,
    otherSupply: Boolean(table.otherSupply),
    ...owner.snapshot(table),
    ...(Number(table.cfg?.play_mode) === 3 && table.preparedHand ? {
      otherShowPoker: [table.preparedHand.player[0]], bankerShowPoker: [table.preparedHand.banker[0]],
    } : {}),
    ...(result ? { showdownPokers: { other: result.player, banker: result.banker },
      showdownPoints: { other: pointStages(result.player), banker: pointStages(result.banker) }, winningAreas: result.areas,
      showdownTypes: { other: result.p, banker: result.b },
      areaWinningScores: result.settlements?.get(Number(session.userId))?.areaWinningScores || {} } : {}),
    totalCardsNum: table.totalCardsNum,
    remainCardsNum: table.remainCardsNum,
    cutIndex: table.cutIndex,
    collectCardCount: table.collectCardCount,
    dealCardCount: table.dealCardCount,
    dealRealCount: table.dealRealCount,
    supplyState: table.supplyState,
    totalBetsByArea: Object.fromEntries(table.totalBetsByArea.map(row => [row.areaId, row.total])),
    ways: roadSnapshot(table),
    points: session.wallet,
    myBets: table.playerBets.get(session.userId) || [],
  };
}

export function onBaccaratJoin(send, table) {
  send(PUSH.ROOM_TYPE_RESULT, {
    roomId: table.roomId,
    roomType: table.roomType,
    conf: baccaratConf(table),
  });
}

export function onBaccaratRooms(send, tables) {
  send(PUSH.GR_GET_ALL_ROOMS_RES, tables.map((item) => ({
    roomId: item.roomId,
    roomIndex: item.roomIndex,
    roomType: item.roomType,
    totalPeople: item.people,
  })));
}

export function onBaccaratEnter(send, table, session) {
  send(PUSH.ENTER_RESPONSE, enterSnapshot(table, session));
}

export function applyCycle(io, table, cycle) {
  if (cycle === 0 || cycle === 1) {
    table.state = cycle === 1 ? 1 : 2;
    prepareHand(io, table);
  } else if (cycle === 3) {
    table.state = 3;
    bankers.lock(table, table.preparedHand || prepareHand(io, table), table.config.bankerAreas || gameConfig.bankerAreas, currentOdds(table));
    bankers.push(io, table, table.config.bankerAreas || gameConfig.bankerAreas);
  } else if (cycle === 4) {
    if (table.lastResult) return;
    table.state = 4;
    if (!table.preparedHand && table.remainCardsNum < (table.config?.reshuffleAt || 30)) {
      table.deck = makeShoe(table.config?.decks || 8);
      table.deckPos = 0;
      table.remainCardsNum = table.deck.length;
    }
    const dealt = table.preparedHand || prepareHand(io, table);
    table.deckPos = dealt.next;
    table.dealCardCount += dealt.player.length + dealt.banker.length;
    table.dealRealCount = table.dealCardCount;
    table.remainCardsNum = table.deck.length - table.deckPos;
    const { areas, p, b } = winningAreas(dealt.player, dealt.banker);
    table.supplyState = supplyState(dealt.player, dealt.banker);
    table.lastResult = { player: dealt.player, banker: dealt.banker, areas, p, b, areaOdds: dealt.areaOdds };
    table.shoeHands = (table.shoeHands || 0) + 1;
    table.ways[1] = [{ winArea: areas.slice(), isLiPai: false, p, b }, ...table.ways[1]].slice(0, 104);
    io.broadcast(PUSH.SHOWDOWN_POKERS, {
      roomType: table.roomType,
      roomId: table.roomId,
      showdownPokers: { other: dealt.player, banker: dealt.banker },
      showdownPoints: { other: pointStages(dealt.player), banker: pointStages(dealt.banker) },
      winningAreas: areas,
      ...owner.snapshot(table),
      showdownTypes: { other: p, banker: b }, realScore: 0, areaWinningScores: {},
      remainCardsNum: table.remainCardsNum,
      cutIndex: table.cutIndex,
    });
  } else if (cycle === 90 || cycle === 91) {
    table.state = 9; table.otherSupply = cycle === 91;
  } else if (cycle === 5) {
    // Legacy direct callers may mark comparison; it must never reopen bets.
    table.state = 5;
  } else if (cycle === 6) {
    table.state = 6;
    const result = table.lastResult;
    if (!result) return;
    return result.settlementTask ||= settleBets(io, table).finally(() => { result.settlementTask = null; });
  } else if (cycle === 7) {
    table.state = 7;
    table.collectCardCount = table.dealCardCount;
  } else if (cycle === 80) {
    table.state = 8; shuffleShoe(io, table);
  } else if (cycle === 8) {
    table.state = 0;
    table.inning += 1;
    table.totalBetsByArea = emptyAreas(oddsMap(table)); table.playerBets.clear();
    table.lastResult = null; table.preparedHand = null;
    table.baccaratFlying = false; owner.beforeRound(io, table);
  } else {
    throw new Error('Unsupported baccarat cycle: ' + cycle);
  }
}

export function tickBaccarat(io, table) {
  table.tick += 1;
  applyCycle(io, table, table.tick % (table.config?.tickCycle || 8));
  io.broadcast(PUSH.GAME_STATE, {
    state: table.state,
    inning: table.inning,
    supplyState: table.supplyState,
    remainCardsNum: table.remainCardsNum,
    cutIndex: table.cutIndex,
    collectCardCount: table.collectCardCount,
    dealCardCount: table.dealCardCount,
    dealRealCount: table.dealRealCount,
  });
}

async function settleBets(io, table) {
  return settleCardBets(io, table, {
    calculate(table, result, mine) {
      const areaWinningScores = {}, betOdds = {};
      let realScore = 0, stake = 0;
      for (const bet of mine) {
        const tier = bet.areaId === 6 ? result.banker.length - 2 : bet.areaId === 7 ? result.player.length - 2
          : bet.areaId === 8 ? result.player.length + result.banker.length - 4 : 0;
        const price = result.areaOdds?.[bet.areaId]?.oddsList[tier]
          ?? Math.round(winningOdds(bet.areaId, result, table.config || gameConfig) * 100);
        if (!Number.isSafeInteger(price) || price < 0) throw new Error('Invalid baccarat payout price');
        const net = result.areas.includes(3) && [1, 2].includes(bet.areaId) ? 0
          : result.areas.includes(bet.areaId) ? Number(BigInt(bet.total) * BigInt(price) / 100n) : -bet.total;
        realScore += net; stake += bet.total; areaWinningScores[bet.areaId] = net;
        betOdds[bet.areaId] = price / 100;
      }
      return { realScore, areaWinningScores, betOdds, payout: stake + realScore, credited: false, notified: false };

    },
    resultPayload(table, result) { return { showdownPokers: { other: result.player, banker: result.banker },
      showdownPoints: { other: pointStages(result.player), banker: pointStages(result.banker) }, ...owner.snapshot(table) }; },
    snapshot: enterSnapshot, record: history.record, bankerAreas: table.config.bankerAreas || gameConfig.bankerAreas,
  });
}
