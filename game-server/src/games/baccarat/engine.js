import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { credit, debit } = await rel(import.meta.url, '../../wallet/index.js', v);
const { makeDeck, shuffle } = await rel(import.meta.url, '../holdem/cards.js', v);
const { baccaratTotal, drawBaccarat } = await rel(import.meta.url, './rules.js', v);
const { default: gameConfig } = await rel(import.meta.url, './config.js', v);
const { hundredWalletContext } = await rel(import.meta.url, '../../core/robot.js', v);

function oddsMap(table) {
  return table.config?.odds || gameConfig.odds;
}

export function emptyAreas(odds) {
  return Array.from({ length: 9 }, (_, i) => ({ areaId: i + 1, total: 0, oddsList: oddsList(i + 1, odds) }));
}

function oddsList(areaId, odds) {
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
      gameName: cfg.gameName,
      gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
      maxBet: Number(table.cfg?.hundred_max_bet || cfg.defaultMaxBet),
      roomIndex: table.roomIndex,
    },
    hundredSwitch: false,
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
    playMode: Number(table.cfg?.play_mode || 0),
  };
}

export function enterSnapshot(table, session) {
  return {
    roomType: table.roomType,
    state: table.state,
    roomId: table.roomId,
    inning: table.inning,
    totalCardsNum: table.totalCardsNum,
    remainCardsNum: table.remainCardsNum,
    cutIndex: table.cutIndex,
    collectCardCount: table.collectCardCount,
    dealCardCount: table.dealCardCount,
    dealRealCount: table.dealRealCount,
    supplyState: table.supplyState,
    totalBetsByArea: table.totalBetsByArea,
    ways: table.ways,
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

export function onBaccaratBet(send, table, session, body) {
  if (table.state !== 2) {
    send(PUSH.BET_RESPONSE, {
      points: session.wallet,
      roomType: table.roomType,
      code: 1,
      myBets: table.playerBets.get(session.userId) || [],
      roomId: table.roomId,
    });
    return;
  }
  const params = Array.isArray(body?.params) ? body.params : [];
  const mine = table.playerBets.get(session.userId) || [];
  for (const item of params) {
    const areaId = Number(item.areaId);
    const total = Number(item.total || 0);
    if (total <= 0 || !debit(session, total).ok) {
      continue;
    }
    const area = table.totalBetsByArea.find((row) => row.areaId === areaId);
    if (area) {
      area.total += total;
    }
    const exist = mine.find((row) => row.areaId === areaId);
    if (exist) {
      exist.total += total;
    } else {
      mine.push({ areaId, total });
    }
  }
  table.playerBets.set(session.userId, mine);
  send(PUSH.BET_BROADCAST, {
    roomId: table.roomId,
    roomType: table.roomType,
    allPlayerBets: table.totalBetsByArea,
  });
  send(PUSH.BET_RESPONSE, {
    points: session.wallet,
    roomType: table.roomType,
    code: 0,
    myBets: mine,
    myTotalBets: mine,
    betAreaIds: mine.map((item) => item.areaId),
    roomId: table.roomId,
  });
}

function winningAreas(player, banker) {
  const p = baccaratTotal(player);
  const b = baccaratTotal(banker);
  const areas = [];
  if (b > p) {
    areas.push(1);
  } else if (p > b) {
    areas.push(2);
  } else {
    areas.push(3);
  }
  if (banker[0] % 13 === banker[1] % 13) {
    areas.push(4);
  }
  if (player[0] % 13 === player[1] % 13) {
    areas.push(5);
  }
  if (b === 6 && b > p) {
    areas.push(9);
  }
  return { areas, p, b };
}

export function applyCycle(io, table, cycle) {
  if (cycle === 3) {
    table.state = 3;
  } else if (cycle === 4) {
    table.state = 4;
    if (table.remainCardsNum < (table.config?.reshuffleAt || 30)) {
      table.deck = makeShoe(table.config?.decks || 8);
      table.deckPos = 0;
      table.remainCardsNum = table.deck.length;
    }
    const dealt = drawBaccarat(table.deck, table.deckPos);
    table.deckPos = dealt.next;
    table.dealCardCount += dealt.player.length + dealt.banker.length;
    table.dealRealCount = table.dealCardCount;
    table.remainCardsNum = table.deck.length - table.deckPos;
    const { areas, p, b } = winningAreas(dealt.player, dealt.banker);
    table.lastResult = { player: dealt.player, banker: dealt.banker, areas, p, b };
    table.ways[1] = [{ winArea: areas[0], p, b }, ...table.ways[1]].slice(0, 104);
    io.broadcast(PUSH.SHOWDOWN_POKERS, {
      roomType: table.roomType,
      roomId: table.roomId,
      showdownPokers: { other: dealt.player, banker: dealt.banker },
      showdownPoints: { other: [p], banker: [b] },
      winningAreas: areas,
      remainCardsNum: table.remainCardsNum,
      cutIndex: table.cutIndex,
    });
  } else if (cycle === 5) {
    table.state = 5;
  } else if (cycle === 6) {
    table.state = 6;
    settleBets(io, table);
  } else if (cycle === 7) {
    table.state = 7;
    table.inning += 1;
    table.totalBetsByArea = emptyAreas(oddsMap(table));
    table.playerBets.clear();
    table.lastResult = null;
  } else {
    table.state = 2;
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

function settleBets(io, table) {
  const result = table.lastResult;
  if (!result || result.settled) {
    return;
  }
  result.settled = true;
  const participants = new Map(table.playerSessions || []);
  const peers = new Map();
  io.forEachPlayer(session => {
    const uid = Number(session.userId);
    peers.set(uid, session.ws);
    if (!participants.has(uid)) participants.set(uid, session);
  });
  for (const [uid, session] of participants) {
    const mine = table.playerBets.get(session.userId) || [];
    let realScore = 0;
    const areaWinningScores = {};
    for (const bet of mine) {
      if (result.areas.includes(bet.areaId)) {
        const win = Math.floor(bet.total * (oddsMap(table)[bet.areaId] || 1));
        credit(session, bet.total + win, hundredWalletContext(io, session));
        realScore += win;
        areaWinningScores[String(bet.areaId)] = win;
      } else {
        realScore -= bet.total;
        areaWinningScores[String(bet.areaId)] = -bet.total;
      }
    }
    const send = (id, payload) => {
      if (session.bot) return;
      if (io.sendUser) io.sendUser(uid, id, payload);
      else if (peers.has(uid)) io.send(peers.get(uid), id, payload);
    };
    send(PUSH.PLAYER_BALANCE_UPDATE, { points: session.wallet });
    send(PUSH.SHOWDOWN_POKERS, {
      roomType: table.roomType,
      roomId: table.roomId,
      showdownPokers: { other: result.player, banker: result.banker },
      showdownPoints: { other: [result.p], banker: [result.b] },
      winningAreas: result.areas,
      areaWinningScores,
      points: session.wallet,
      realScore,
      remainCardsNum: table.remainCardsNum,
      cutIndex: table.cutIndex,
    });
    if (table.visitors && !table.visitors.has(uid)) table.playerSessions?.delete(uid);
  }
  table.hundredSettledInning = table.inning;
}
