import { PUSH } from "../../messages.js";
import { debit } from "../../wallet/index.js";
import { memberListSeats, publicObserver, publicSeat, userInfoOf } from "../../core/member.js";
import { OP } from "./op.js";
import { cardName, compareRank, evaluate7, makeDeck, shuffle } from "./cards.js";
import gameConfig from "./config.js";
import { rel } from "../../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const robot = await rel(import.meta.url, "./robot.js", version);
// Compatibility for existing callers; all robot behavior lives in robot.js.
export const { BOT_UID, ensureBots, ensureBot, botChoose } = robot;

function num(row, key, fallback = 0) {
  const value = row?.[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// Holdem history in the client uses the numeric GameState enum. These values
// are also used by the client's replay timeline (BET_PERFLOP=4, BET_FLOP=6,
// BET_TURN=8, BET_RIVER=10).
const REPLAY_GAME_STATE = {
  BET_FRONT: 1,
  BET_BLIND: 2,
  DEAL_FLOP: 5,
  BET_PERFLOP: 4,
  DEAL_TURN: 7,
  BET_FLOP: 6,
  DEAL_RIVER: 9,
  BET_TURN: 8,
  BET_RIVER: 10,
};

function positionNames(playerCount) {
  const byCount = {
    2: [1, 3],
    3: [1, 2, 3],
    4: [1, 2, 3, 10],
    5: [1, 2, 3, 5, 10],
    6: [1, 2, 3, 5, 9, 10],
    7: [1, 2, 3, 5, 6, 9, 10],
    8: [1, 2, 3, 5, 6, 8, 9, 10],
    9: [1, 2, 3, 5, 6, 7, 8, 9, 10],
    10: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  };
  return byCount[playerCount] || Array.from({ length: playerCount }, (_, index) => index + 1);
}

function hasVisibleHoleCards(cards) {
  return Array.isArray(cards) && cards.length >= 2
    && cards.slice(0, 2).every((card) => card != null && Number(card) !== -1);
}

function historyPlayerHoleCards(player) {
  if (Array.isArray(player?.showCards)) return player.showCards.slice(0, 2);
  const cards = Array.isArray(player?.cards) ? player.cards : [];
  if (hasVisibleHoleCards(cards)) return cards.slice(0, 2);
  const dealt = (Array.isArray(player?.operateList) ? player.operateList : [])
    .find((action) => Number(action?.gameState) === 3 && hasVisibleHoleCards(action?.cards));
  if (hasVisibleHoleCards(dealt?.cards)) return dealt.cards.slice(0, 2);
  return hasVisibleHoleCards(player?.handPais) && player.handPais.length === 2
    ? player.handPais.slice()
    : [];
}

function historyPlayerHasFolded(player) {
  if (player?.folded) return true;
  return (Array.isArray(player?.operateList) ? player.operateList : []).some((action) =>
    Number(action?.operate ?? action?.operationType) === OP.ABANDON);
}

function historyPlayerCanShowCards(player, forceShowCard) {
  if (forceShowCard) return true;
  if (Array.isArray(player?.showCards)) return hasVisibleHoleCards(player.showCards);
  if (player?.showCards != null) return Boolean(player.showCards);
  return !historyPlayerHasFolded(player) && hasVisibleHoleCards(historyPlayerHoleCards(player));
}

function historyPlayerForClient(player, index, forceShowCard) {
  const uid = Number(player?.uid) || 0;
  const score = Number(player?.score) || 0;
  const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
  const holeCards = historyPlayerHoleCards(player);
  const visibleHoleCards = canShowCards && holeCards.length === 2 ? holeCards : [-1, -1];
  const fullCards = Array.isArray(player?.cards) ? player.cards.slice() : [];
  const commonPoker = Array.isArray(player?.commonPoker) && player.commonPoker.length
    ? player.commonPoker.slice()
    : (fullCards.length >= 7 ? fullCards.slice(2, 7) : []);
  const cardTypeInfo = player?.cardTypeInfo || {};
  const evaluatedHand = canShowCards && holeCards.length === 2 && commonPoker.length >= 5
    ? evaluate7([...holeCards, ...commonPoker.slice(0, 5)])
    : null;
  const storedBestHand = Array.isArray(cardTypeInfo.handCardList) && cardTypeInfo.handCardList.length
    ? cardTypeInfo.handCardList
    : (Array.isArray(player?.cardTypePokers) && player.cardTypePokers.length
      ? player.cardTypePokers
      : null);
  const bestHand = storedBestHand
    ? storedBestHand.slice()
    : (evaluatedHand?.best5 || (Array.isArray(player?.handPais) ? player.handPais.slice() : []));
  const storedCardTypeId = Number(cardTypeInfo.cardTypeId ?? player?.cardTypeId);
  const cardTypeId = canShowCards
    ? (storedCardTypeId > 0 ? storedCardTypeId : (evaluatedHand?.cardTypeId || 0))
    : -1;
  const sourceUserInfo = player?.userInfo || {};
  const userInfo = userInfoOf({
    uid,
    name: player?.userName ?? sourceUserInfo.userName ?? sourceUserInfo.name ?? player?.name,
    icon: player?.userIcon ?? player?.icon ?? sourceUserInfo.userIcon ?? sourceUserInfo.icon,
  });
  const posName = Number(player?.posName);
  const seatPos = Number(player?.pos);
  const actions = (Array.isArray(player?.operateList) ? player.operateList : [])
    .filter((action) => ![3, 5, 7, 9].includes(Number(action?.gameState)))
    .map((action) => {
      const { cards, replayOrder, ...row } = action || {};
      const operation = Number(row.operate ?? row.operationType) || 0;
      return {
        ...row,
        operate: operation,
        operationType: Number(row.operationType ?? row.operate) || operation,
      };
    });
  const cardStages = [
    { operate: 0, operationType: 0, gameState: 3, cards: visibleHoleCards },
  ];
  if (commonPoker.length >= 3) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 5, cards: commonPoker.slice(0, 3) });
  }
  if (commonPoker.length >= 4) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 7, cards: [commonPoker[3]] });
  }
  if (commonPoker.length >= 5) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 9, cards: [commonPoker[4]] });
  }
  const summary = { ...player };
  for (const key of ["openingPoint", "cardTypeInfo", "icon", "userIcon", "posName", "showCards", "cards", "handPais", "commonPoker", "operateList"]) {
    delete summary[key];
  }
  const cards = fullCards.length
    ? fullCards
    : [...holeCards, ...commonPoker];
  if (!canShowCards) {
    cards[0] = -1;
    cards[1] = -1;
  }
  const isWin = player?.isWin == null ? score > 0 : Boolean(player.isWin);
  return {
    ...summary,
    uid,
    userName: userInfo.name,
    userIcon: userInfo.icon,
    userInfo: { ...userInfo, userName: userInfo.name, userIcon: userInfo.icon },
    posName: Number.isInteger(posName) && posName >= 1 && posName <= 10
      ? posName
      : (Number.isInteger(seatPos) && seatPos >= 0 && seatPos < 10 ? seatPos : index % 10) + 1,
    score,
    isWin,
    cardTypeId,
    cardTypePokers: canShowCards ? bestHand : [],
    handPais: canShowCards ? bestHand : [],
    showCards: visibleHoleCards,
    cards,
    commonPoker,
    operateList: [...actions, ...cardStages],
  };
}

export function createTexasTable(roomId, roomType, cfg) {
  const smallBlind = num(cfg, "small_blind", gameConfig.defaultSmallBlind);
  const bigBlind = num(cfg, "big_blind", gameConfig.defaultBigBlind);
  return {
    gameId: gameConfig.id,
    kind: gameConfig.kind,
    roomId: Number(roomId),
    roomType: Number(roomType) || gameConfig.roomTypes[0],
    cfg,
    config: gameConfig,
    currentInning: 0,
    roomState: 0,
    members: [],
    observers: [],
    history: [],
    smallBlind,
    bigBlind,
    carryMin: num(cfg, "carry_min", gameConfig.defaultCarryMin),
    forceShowCard: Number(cfg?.force_show_card) === 1,
    playMode: num(cfg, "play_mode", 0),
    roomClassification: 2,
    betTime: gameConfig.betTime,
    dealerPos: 0,
    phase: "idle",
    startAt: 0,
    hand: null,
  };
}

function dzpkParams(table) {
  return {
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
    straddle: false,
    delayLook: true,
    openInsurance: false,
    forceShowCard: table.forceShowCard,
    forceShowType: table.forceShowCard ? 1 : 0,
    carryMin: table.carryMin,
    carryMax: -1,
    betTime: table.betTime,
    observed: true,
    taxType: 0,
    taxPercent: 0,
    banTalk: false,
    openAuditCarry: false,
    openTaxNoLimit: true,
  };
}

export function texasConf(table) {
  const params = dzpkParams(table);
  return {
    roomType: gameConfig.confRoomType,
    minPeople: gameConfig.minPeople,
    maxPeople: gameConfig.maxPeople,
    dzpkParams: params,
    dzpk: {
      ...params,
      gameName: gameConfig.name,
    },
    playMode: Number(table.playMode) || 0,
    allowCarryOut: true,
    roomClassification: table.roomClassification,
    gameRoomConfigId: num(table.cfg, "game_room_config_id", 0),
    hundredSwitch: false,
  };
}

export function texasRoomInfo(table) {
  return {
    roomId: table.roomId,
    roomType: table.roomType,
    currentInning: table.currentInning,
    maxPeople: 7,
    roomState: table.phase === "playing" ? 2 : 1,
    memberList: memberListSeats(table.members, 7),
    OBmemberList: (table.observers || []).map((item) => publicObserver(item)),
    dzpk: {
      gameName: gameConfig.name,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      initialBet: table.bigBlind,
      carryMin: table.carryMin,
      carryMax: -1,
      betTime: table.betTime,
      forceShowCard: table.forceShowCard,
      openInsurance: false,
    },
    roomStart: table.members.length >= 2,
    memberNum: table.members.length,
  };
}

function publicMember(m) {
  return publicSeat(m);
}

export function onTexasJoin(send, table, session, body) {
  const isOb = Boolean(body?.isOb);
  if (isOb) {
    if (!table.observers.some((item) => item.uid === session.userId)) {
      table.observers.push({ uid: session.userId, name: session.name, point: Number(session.wallet) || 0 });
    }
  } else if (!table.members.some((item) => item.uid === session.userId)) {
    const used = new Set(table.members.map((item) => item.pos));
    let pos = 0;
    while (used.has(pos) && pos < 7) {
      pos += 1;
    }
    const buyIn = Math.min(Math.max(session.wallet, 0), Math.max(table.carryMin, table.bigBlind * gameConfig.buyInBb));
    if (!debit(session, buyIn).ok) {
      return;
    }
    table.members.push({
      uid: session.userId,
      name: session.name,
      point: buyIn,
      pos,
      state: 1,
      lastOperation: 0,
      totalBet: 0,
      dealer: false,
    });
    send(PUSH.JOIN_ROOM, publicMember(table.members[table.members.length - 1]));
    ensureBot(table);
  }
  send(PUSH.DZPK_PUSH_WATCHGAME, table.observers);
  send(PUSH.ROOM_TYPE_RESULT, {
    roomId: table.roomId,
    roomType: table.roomType,
    conf: texasConf(table),
  });
  maybeQueueStart(table);
}

export function onTexasLoginRoom(send, table, session) {
  send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
  send(PUSH.ROOM_INFO, texasRoomInfo(table));
  if (table.phase === "playing" && table.hand) {
    send(PUSH.BRNN_GAME_STATE_PUSH, table.hand.street);
    pushPlayingSnapshot(send, table, session);
  }
}

export function onGtoReq(send, payload) {
  let ops = [];
  try {
    ops = JSON.parse(payload?.tipsListStr || "[]");
  } catch {
    ops = [];
  }
  const keys = ops.filter((item) => item && item.operation != null);
  const share = keys.length ? 1 / keys.length : 0;
  const res = {};
  for (const item of keys) {
    res[String(item.operation)] = share;
  }
  send(PUSH.GTO_RES, res);
}

// Development history is volatile and scoped to the room's in-memory table.
export function texasHistoryPayload(table, request = {}) {
  const roomId = Number(request.roomId);
  const begin = Number(request.beginNum);
  const end = Number(request.endNum);
  const excellentGame = Boolean(request.excellentGame);
  const available = (table.history || []).filter((item) =>
    (!roomId || Number(item.gameRoomId) === roomId)
    && (!excellentGame || item.firstGameList.some((player) =>
      player.operateList.some((action) => action.operate === OP.ALL_IN))),
  ).sort((a, b) => Number(a.currentInningNum) - Number(b.currentInningNum));

  // The online client sends inningNum - 1 in beginNum/endNum. Negative bounds
  // request the latest page; excellent mode's 0/0 request asks for all matches.
  const excellentAll = excellentGame && begin === 0 && end === 0;
  const latestPage = (!Number.isFinite(begin) || begin < 0)
    && (!Number.isFinite(end) || end < 0);
  let list;
  if (excellentAll) {
    list = available;
  } else if (latestPage) {
    list = available.slice(-20);
  } else {
    const firstInning = Number.isFinite(begin) && begin >= 0 ? Math.trunc(begin) + 1 : Number.MIN_SAFE_INTEGER;
    const lastInning = Number.isFinite(end) && end >= 0 ? Math.trunc(end) + 1 : Number.MAX_SAFE_INTEGER;
    list = available.filter((item) =>
      Number(item.currentInningNum) >= firstInning
      && Number(item.currentInningNum) <= lastInning);
    list = list.slice(0, 20);
  }
  const totalNum = available.reduce((max, item) => Math.max(max, Number(item.currentInningNum) || 0), 0);
  return {
    excellentGame,
    isOfflineData: false,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
    beginNum: list.length ? list[0].currentInningNum : 0,
    endNum: list.length ? list[list.length - 1].currentInningNum : 0,
    totalNum,
    roomTypeName: "dzpk",
    // The client's HistoryModel.getBlind parses this field as JSON, then
    // formats the score values into display units.
    blind: JSON.stringify({
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      initialBet: table.bigBlind,
      isStraddle: false,
    }),
    gameRoomId: table.roomId,
    playBackList: list.map(({ roundEvents, forceShowCard, ...item }) => ({
      ...item,
      firstGameList: (item.firstGameList || []).map((player, index) =>
        historyPlayerForClient(player, index, forceShowCard)),
      secondGameList: (item.secondGameList || []).map((player, index) =>
        historyPlayerForClient(player, index, forceShowCard)),
    })),
  };
}

// Adapt the volatile development replay into the same detail envelope the
// Holdem history panel reads from hall op=46. Production detail remains owned
// by data-center and is intentionally not served from this room memory.
export function texasHistoryDetail(table, inningNum) {
  const inning = Number(inningNum);
  const replay = (table.history || []).find((item) => Number(item.currentInningNum) === inning);
  if (!replay) return null;
  const players = replay.firstGameList || [];
  const forceShowCard = Boolean(replay.forceShowCard ?? table.forceShowCard);
  const fallbackActions = players.flatMap((player) => {
    return (player.operateList || []).map((action) => ({
      ...action,
      uid: Number(player.uid),
    }));
  });
  const hasRecordedTimeline = Array.isArray(replay.roundEvents);
  let events = hasRecordedTimeline
    ? replay.roundEvents.map((event) => ({ ...event }))
    : fallbackActions;
  if (!hasRecordedTimeline) {
    // Older in-memory histories lack cross-player order; reconstruct street and
    // pot progression as the best available fallback. New hands record sequence.
    events.sort((a, b) => Number(a.gameState || 0) - Number(b.gameState || 0)
      || Number(a.pot || 0) - Number(b.pot || 0));
    const board = players.find((player) => Array.isArray(player.commonPoker))?.commonPoker || [];
    const deals = [
      { gameState: REPLAY_GAME_STATE.DEAL_FLOP, cardCount: 3 },
      { gameState: REPLAY_GAME_STATE.DEAL_TURN, cardCount: 4 },
      { gameState: REPLAY_GAME_STATE.DEAL_RIVER, cardCount: 5 },
    ].filter((deal) => board.length >= deal.cardCount).map((deal) => {
      const nextAction = events.find((event) => Number(event.gameState) > deal.gameState);
      return {
        ...deal,
        uid: 0,
        operationType: 0,
        pot: Math.max(0, Number(nextAction
          ? Number(nextAction.pot || 0) - Number(nextAction.currentBetScore ?? nextAction.bet ?? 0)
          : replay.pot) || 0),
        board: board.slice(0, deal.cardCount),
      };
    });
    let nextDeal = 0;
    const timeline = [];
    for (const event of events) {
      while (nextDeal < deals.length && deals[nextDeal].gameState < Number(event.gameState)) {
        timeline.push(deals[nextDeal]);
        nextDeal += 1;
      }
      timeline.push(event);
    }
    timeline.push(...deals.slice(nextDeal));
    events = timeline;
  }
  events.forEach((event, index) => {
    if (!Number.isFinite(Number(event.replayOrder))) event.replayOrder = index;
  });
  let replayOrder = events.reduce((max, event) => Number.isFinite(Number(event.replayOrder))
    ? Math.max(max, Number(event.replayOrder)) : max, -1) + 1;
  players.forEach((player, index) => {
    if (!historyPlayerCanShowCards(player, forceShowCard)) return;
    const clientPlayer = historyPlayerForClient(player, index, forceShowCard);
    events.push({
      replayOrder: replayOrder++,
      uid: Number(player.uid),
      operationType: OP.SHOW,
      gameState: 11,
      pot: Number(replay.pot) || 0,
      cards: [...clientPlayer.showCards, ...clientPlayer.commonPoker],
    });
  });
  events.sort((a, b) => Number(a.replayOrder ?? 0) - Number(b.replayOrder ?? 0));
  const roomConfig = {
    maxPeople: Number(table.config?.maxPeople) || 7,
    roomType: Number(table.roomType),
    roomId: Number(table.roomId),
    dzpkParams: {
      smallBlind: Number(replay.smallBlind ?? table.smallBlind) || 0,
      bigBlind: Number(replay.bigBlind ?? table.bigBlind) || 0,
      initialBet: Number(replay.initialBet ?? table.bigBlind) || 0,
    },
  };
  const detail = {
    gameInningId: `${Number(table.roomId)}_${inning}`,
    gameRoomUnion: {
      gameRoomId: Number(table.roomId),
      roomId: Number(table.roomId),
      roomConfig: JSON.stringify(roomConfig),
    },
    inningResults: JSON.stringify(players.map((player, index) => {
      const clientPlayer = historyPlayerForClient(player, index, forceShowCard);
      const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
      const cardTypeInfo = player.cardTypeInfo || {};
      const result = {
        uid: clientPlayer.uid,
        userName: clientPlayer.userName,
        userIcon: clientPlayer.userIcon,
        posName: clientPlayer.posName,
        score: clientPlayer.score,
        isWin: clientPlayer.isWin,
        cardTypeId: clientPlayer.cardTypeId,
        // op=46 renders handPais beside commonPokerList. Unlike the settlement
        // best-five field, this detail field must contain only revealed holes.
        handPais: canShowCards ? clientPlayer.showCards.slice() : [],
        showCards: clientPlayer.showCards,
        cardTypePokers: clientPlayer.cardTypePokers,
        commonPokerList: clientPlayer.commonPoker,
        operateList: clientPlayer.operateList,
        winInsurance: Number(player.winInsurance) || 0,
        insuranceBet: Number(player.insuranceBet) || 0,
      };
      if (canShowCards) {
        result.cardTypeInfo = {
          cardTypeId: clientPlayer.cardTypeId,
          handCardList: clientPlayer.cardTypePokers.slice(),
          pokerEnumList: Array.isArray(cardTypeInfo.pokerEnumList) ? cardTypeInfo.pokerEnumList.slice() : [],
        };
      }
      return result;
    })),
    // HoldemHistoryModel.onPushRecordDetail parses this field unconditionally.
    inningInfo: JSON.stringify({ forceShowCard }),
    roundList: JSON.stringify(events.map((action) => {
      const cards = Array.isArray(action.cards) ? action.cards : [];
      const board = Array.isArray(action.board) ? action.board : cards.slice(2);
      return {
        uid: Number(action.uid) || 0,
        operationType: Number(action.operationType ?? action.operate) || 0,
        gameState: Number(action.gameState) || 0,
        bet: Number(action.bet) || 0,
        roundBetScore: Number(action.roundBetScore ?? action.bet) || 0,
        currentBetScore: Number(action.currentBetScore) || 0,
        totalBetScore: Number(action.totalBetScore) || 0,
        pot: Number(action.pot) || 0,
        flopPokerList: board.slice(0, 3),
        turnPoker: board[3] ?? -1,
        riverPoker: board[4] ?? -1,
        operationDuration: 1,
      };
    })),
    memberResults: players.map((player, pos) => {
      const clientPlayer = historyPlayerForClient(player, pos, forceShowCard);
      const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
      return {
        uid: clientPlayer.uid,
        pos: Number.isInteger(player.pos) ? player.pos : pos,
        posName: clientPlayer.posName,
        pais: canShowCards ? clientPlayer.showCards.slice() : [],
        score: clientPlayer.score,
        point: Number(player.openingPoint) || 0,
        openingPoint: Number(player.openingPoint) || 0,
        userInfo: clientPlayer.userInfo,
      };
    }),
  };
  return { exploitsInfoMsgs: [detail] };
}

function maybeQueueStart(table) {
  if (table.phase === "idle" && seated(table).length >= gameConfig.minPeople) {
    table.phase = "starting";
    table.startAt = Date.now() + gameConfig.startDelayMs;
  }
}

function seated(table) {
  return table.members.filter((m) => m.point > 0);
}

export function tickTexas(io, table, now = Date.now()) {
  if (table.phase === "starting" && now >= table.startAt) {
    beginHand(io, table);
    return;
  }
  tickPlaying(io, table, now);
}

export function tickPlaying(io, table, now = Date.now()) {
  if (table.phase !== "playing" || !table.hand) {
    return;
  }
  const actor = currentActor(table);
  if (!actor) {
    return;
  }
  if (robot.tickBot(table, actor, now, (uid, operation, data) => applyAction(io, table, uid, operation, data))) return;
  if (now >= table.hand.deadline) {
    const canCheck = actor.streetBet >= table.hand.currentBet;
    applyAction(io, table, actor.uid, canCheck ? OP.PASS : OP.ABANDON, 0);
  }
}

export function onTexasAction(io, table, session, body) {
  if (table.phase !== "playing" || !table.hand) {
    return;
  }
  const uid = Number(body?.uid || session.userId);
  applyAction(io, table, uid, Number(body?.operation), body?.operationData);
}

export function beginHand(io, table) {
  const players = seated(table);
  if (players.length < 2) {
    table.phase = "idle";
    return;
  }
  table.phase = "playing";
  table.roomState = 2;
  table.currentInning += 1;
  players.sort((a, b) => a.pos - b.pos);
  table.dealerPos = (table.dealerPos + 1) % players.length;
  const dealer = players[table.dealerPos];
  const sb = players.length === 2 ? dealer : players[(table.dealerPos + 1) % players.length];
  const bb = players.length === 2
    ? players[(table.dealerPos + 1) % players.length]
    : players[(table.dealerPos + 2) % players.length];
  const utg = players[(players.indexOf(bb) + 1) % players.length];
  const handPositions = positionNames(players.length);
  for (let index = 0; index < players.length; index += 1) {
    const player = players[(table.dealerPos + index) % players.length];
    player.posName = handPositions[index];
  }
  for (const m of table.members) {
    m.dealer = m.uid === dealer.uid;
    m.folded = false;
    m.allIn = false;
    m.hole = [];
    m.streetBet = 0;
    m.totalBet = 0;
    m.lastOperation = 0;
    m.openingPoint = m.point;
  }
  const deck = shuffle(makeDeck());
  table.hand = {
    deck,
    deckPos: 0,
    board: [],
    street: "BET_PERFLOP",
    pot: 0,
    currentBet: table.bigBlind,
    minRaise: table.bigBlind,
    actorUid: utg.uid,
    lastRaiseUid: bb.uid,
    acted: new Set(),
    deadline: Date.now() + table.betTime * 1000,
    smallBlindId: sb.uid,
    bigBlindId: bb.uid,
    bankerId: dealer.uid,
    underTheGunUid: utg.uid,
    replayActions: [],
    replayEvents: [],
  };
  io.broadcast(PUSH.NIUNIU_CURRENT_INNING_BEGIN_INFO, {
    currentInning: table.currentInning,
    uidList: players.map((p) => p.uid),
    startTime: Date.now(),
    playMode: table.playMode,
  });
  io.broadcast(PUSH.DZPK_ZHUANG_PUSH, {
    bankerId: dealer.uid,
    smallBlindId: sb.uid,
    bigBlindId: bb.uid,
    straddleUid: 0,
    underTheGunUid: utg.uid,
  });
  io.broadcast(PUSH.QIPAI_RESULT, { result: true, currentInning: table.currentInning });
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FRONT");
  for (const player of players) {
    postInitialBet(io, table, player, table.bigBlind);
  }
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_BLIND");
  postBlind(io, table, sb, table.smallBlind, OP.BLIND);
  postBlind(io, table, bb, table.bigBlind, OP.BLIND);
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_PERFLOP");
  for (const p of players) {
    p.hole = [deck[table.hand.deckPos], deck[table.hand.deckPos + 1]];
    table.hand.deckPos += 2;
  }
  io.forEachPlayer((session) => {
    io.send(session.ws, PUSH.DZPK_DEAL_DI_PUSH, players.map((p) => ({
      uid: p.uid,
      cardList: session.userId === p.uid ? p.hole : [-1, -1],
    })));
    const self = players.find((p) => p.uid === session.userId);
    if (self) {
      io.send(session.ws, PUSH.DZPK_CARDTYPE_PUSH, holeType(self.hole));
    }
  });
  table.hand.street = "BET_PERFLOP";
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_PERFLOP");
  promptActor(io, table);
}

function postInitialBet(io, table, player, amount) {
  const pay = Math.min(player.point, amount);
  player.point -= pay;
  player.totalBet += pay;
  player.lastOperation = OP.PER;
  if (player.point === 0) {
    player.allIn = true;
  }
  table.hand.pot += pay;
  recordReplayAction(table, player, OP.PER, pay, REPLAY_GAME_STATE.BET_FRONT);
  pushAction(io, table, player, OP.PER, pay);
}

function postBlind(io, table, player, amount, operation) {
  const pay = Math.min(player.point, amount);
  player.point -= pay;
  player.streetBet += pay;
  player.totalBet += pay;
  player.lastOperation = operation;
  if (player.point === 0) {
    player.allIn = true;
  }
  table.hand.pot += pay;
  recordReplayAction(table, player, operation, pay, REPLAY_GAME_STATE.BET_BLIND);
  pushAction(io, table, player, operation, pay);
}

function holeType(hole) {
  const pair = rankPair(hole);
  return {
    pokerEnumList: hole.map(cardName),
    handCardList: hole,
    cardTypeId: pair ? 2 : 1,
  };
}

function rankPair(hole) {
  return hole[0] % 13 === hole[1] % 13;
}

function currentActor(table) {
  return table.members.find((m) => m.uid === table.hand.actorUid) || null;
}

function live(table) {
  return table.members.filter((m) => !m.folded && m.hole?.length);
}

function canAct(m) {
  return !m.folded && !m.allIn && m.point > 0;
}

function applyAction(io, table, uid, operation, operationData) {
  const actor = currentActor(table);
  if (!actor || actor.uid !== uid) {
    return;
  }
  const hand = table.hand;
  const streetBetBefore = actor.streetBet;
  const toCall = Math.max(0, hand.currentBet - actor.streetBet);
  let op = Number(operation);
  const amountOps = [OP.ALL_IN, OP.FOLLOW, OP.ADD, OP.BET, OP.POT_1, OP.POT_2, OP.POT_3, OP.POT_4, OP.POT_5, OP.CUSTOM_ADD];
  const amount = operationData == null || operationData === "" ? 0 : Number(operationData);
  if (amountOps.includes(op) && !Number.isFinite(amount)) {
    return;
  }
  if (op === OP.PASS && toCall > 0) {
    op = OP.POT_1;
  }
  if (op === OP.PASS) {
    actor.lastOperation = OP.PASS;
  } else if (op === OP.ABANDON) {
    actor.folded = true;
    actor.lastOperation = OP.ABANDON;
  } else if (op === OP.FOLLOW) {
    payTo(actor, hand, toCall);
    actor.lastOperation = actor.point === 0 ? OP.ALL_IN : OP.FOLLOW;
    if (actor.point === 0) {
      actor.allIn = true;
    }
  } else if (amountOps.includes(op) && op !== OP.FOLLOW) {
    const raiseTo = op === OP.ALL_IN
      ? actor.streetBet + actor.point
      : raiseAmount(table, actor, amount);
    const pay = Math.min(actor.point, Math.max(0, raiseTo - actor.streetBet));
    payTo(actor, hand, pay);
    if (actor.streetBet > hand.currentBet) {
      hand.minRaise = actor.streetBet - hand.currentBet;
      hand.currentBet = actor.streetBet;
      hand.lastRaiseUid = actor.uid;
      hand.acted = new Set([actor.uid]);
    }
    actor.lastOperation = actor.point === 0 ? OP.ALL_IN : op;
    if (actor.point === 0) {
      actor.allIn = true;
    }
  } else {
    actor.lastOperation = op;
  }
  hand.acted.add(actor.uid);
  recordReplayAction(table, actor, actor.lastOperation, actor.streetBet - streetBetBefore, REPLAY_GAME_STATE[hand.street]);
  pushAction(io, table, actor, actor.lastOperation, actor.streetBet - streetBetBefore);
  const remaining = live(table);
  if (remaining.length === 1) {
    settle(io, table, remaining);
    return;
  }
  if (streetClosed(table)) {
    nextStreet(io, table);
    return;
  }
  hand.actorUid = nextActorUid(table, actor.uid);
  promptActor(io, table);
}

function recordReplayAction(table, player, operation, bet, gameState) {
  const hand = table.hand;
  hand.replayActions ||= [];
  hand.replayEvents ||= [];
  const action = {
    replayOrder: hand.replayEvents.length,
    uid: player.uid,
    operate: operation,
    operationType: operation,
    bet: Number(bet) || 0,
    currentBetScore: Number(bet) || 0,
    totalBetScore: Number(player.totalBet) || 0,
    pot: Number(hand.pot) || 0,
    gameState: Number(gameState) || 0,
    cards: [...(player.hole || []), ...hand.board],
  };
  hand.replayActions.push(action);
  hand.replayEvents.push(action);
}

function recordReplayDeal(hand, gameState) {
  hand.replayEvents ||= [];
  hand.replayEvents.push({
    replayOrder: hand.replayEvents.length,
    uid: 0,
    operationType: 0,
    bet: 0,
    roundBetScore: 0,
    currentBetScore: 0,
    totalBetScore: 0,
    pot: Number(hand.pot) || 0,
    gameState,
    board: [...hand.board],
  });
}

function payTo(player, hand, amount) {
  const pay = Math.min(player.point, Math.max(0, amount));
  player.point -= pay;
  player.streetBet += pay;
  player.totalBet += pay;
  hand.pot += pay;
}

function raiseAmount(table, actor, operationData) {
  const hand = table.hand;
  const data = Number(operationData ?? 0);
  const target = Math.round(data * 100);
  return Math.min(actor.streetBet + actor.point, Math.max(hand.currentBet + hand.minRaise, target));
}

function streetClosed(table) {
  const actors = live(table).filter(canAct);
  if (!actors.length) {
    return true;
  }
  return actors.every((m) => m.streetBet === table.hand.currentBet && table.hand.acted.has(m.uid));
}

function nextActorUid(table, fromUid) {
  const order = live(table).sort((a, b) => a.pos - b.pos);
  const idx = order.findIndex((m) => m.uid === fromUid);
  for (let i = 1; i <= order.length; i += 1) {
    const m = order[(idx + i) % order.length];
    if (canAct(m)) {
      return m.uid;
    }
  }
  return 0;
}

function firstActorUid(table) {
  const order = live(table).sort((a, b) => a.pos - b.pos);
  const sb = order.find((m) => m.uid === table.hand.smallBlindId) || order[0];
  const idx = order.indexOf(sb);
  for (let i = 0; i < order.length; i += 1) {
    const m = order[(idx + i) % order.length];
    if (canAct(m)) {
      return m.uid;
    }
  }
  return 0;
}

function nextStreet(io, table) {
  const hand = table.hand;
  for (const m of table.members) {
    m.streetBet = 0;
  }
  hand.currentBet = 0;
  hand.minRaise = table.bigBlind;
  hand.acted = new Set();
  const livePlayers = live(table);
  if (livePlayers.filter(canAct).length <= 1 && livePlayers.length > 1) {
    dealRemaining(table);
    settle(io, table, livePlayers);
    return;
  }
  if (hand.street === "BET_PERFLOP") {
    hand.board.push(hand.deck[hand.deckPos], hand.deck[hand.deckPos + 1], hand.deck[hand.deckPos + 2]);
    hand.deckPos += 3;
    hand.street = "BET_FLOP";
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_FLOP);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_FLOP");
    io.broadcast(PUSH.DZPK_DEAL_FAN_PUSH, { cardList: hand.board.slice(0, 3) });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FLOP");
  } else if (hand.street === "BET_FLOP") {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    hand.street = "BET_TURN";
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_TURN);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_TURN");
    io.broadcast(PUSH.DZPK_DEAL_ZHUANG_PUSH, { cardList: [hand.board[3]] });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_TURN");
  } else if (hand.street === "BET_TURN") {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    hand.street = "BET_RIVER";
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_RIVER);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_RIVER");
    io.broadcast(PUSH.DZPK_DEAL_HE_PUSH, { cardList: [hand.board[4]] });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_RIVER");
  } else {
    settle(io, table, live(table));
    return;
  }
  io.broadcast(PUSH.DZPK_BIANCHI_PUSH, [hand.pot]);
  hand.actorUid = firstActorUid(table);
  if (!hand.actorUid) {
    nextStreet(io, table);
    return;
  }
  promptActor(io, table);
}

function dealRemaining(table) {
  const hand = table.hand;
  if (hand.board.length < 3) {
    while (hand.board.length < 3) {
      hand.board.push(hand.deck[hand.deckPos]);
      hand.deckPos += 1;
    }
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_FLOP);
  }
  if (hand.board.length < 4) {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_TURN);
  }
  if (hand.board.length < 5) {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_RIVER);
  }
}

function promptActor(io, table) {
  const actor = currentActor(table);
  if (!actor) {
    nextStreet(io, table);
    return;
  }
  table.hand.deadline = Date.now() + table.betTime * 1000;
  robot.scheduleTurn(table, actor);
  io.broadcast(PUSH.DZPK_OPERATION_PLAYER_PUSH, {
    uid: actor.uid,
    leftTime: table.betTime,
    buyDelayCount: 0,
    delayLeftCount: 0,
    isByDelay: false,
  });
  const operations = actionOptions(table, actor);
  // 3426 contains private controls. It must never be broadcast to the room:
  // observers do not have a seat, so the client cannot calculate their all-in
  // amount and will render NaN. Production IO supplies sendUser; a test/dummy
  // IO without it deliberately sends nothing.
  if (typeof io.sendUser === "function") {
    io.sendUser(actor.uid, PUSH.DZPK_OPERATION_PUSH, operations);
  }
}

function actionOptions(table, actor) {
  const toCall = Math.max(0, table.hand.currentBet - actor.streetBet);
  const point = Number(actor.point);
  const playerAmount = Number.isFinite(point) ? Math.max(0, point) : 0;
  const opts = [{ operation: OP.ABANDON, data: 0, playerAmount }];
  if (toCall === 0) {
    opts.push({ operation: OP.PASS, data: 0, playerAmount });
    opts.push({ operation: OP.BET, data: table.bigBlind, playerAmount });
  } else {
    opts.push({
      operation: OP.FOLLOW,
      data: Math.min(playerAmount, toCall),
      playerAmount,
    });
    const minRaiseTo = table.hand.currentBet + table.hand.minRaise;
    if (actor.streetBet + playerAmount > minRaiseTo) {
      opts.push({
        operation: OP.ADD,
        data: minRaiseTo,
        playerAmount,
      });
    }
  }
  opts.push({ operation: OP.ALL_IN, data: 0, playerAmount });
  // The client builds its shortcut amounts from these fields when CUSTOM_ADD
  // is present: pot is the current hand pot, and followTotalBet is this
  // player's amount to call. Keep the values in protocol score units.
  opts.push({
    operation: OP.CUSTOM_ADD,
    data: 0,
    playerAmount,
    userData: {
      bigBlind: table.bigBlind,
      pot: Number(table.hand?.pot) || 0,
      followTotalBet: toCall,
    },
  });
  return opts;
}

function pushAction(io, table, player, operation, currentBetScore = 0) {
  io.broadcast(PUSH.DZPK_ACTION_BET_PUSH, {
    uid: player.uid,
    currentBetScore: Number(currentBetScore) || 0,
    totalBetScore: Number(player.totalBet) || 0,
    operation,
    point: Number(player.point) || 0,
    pot: Number(table.hand?.pot) || 0,
  });
}

export function pushPlayingSnapshot(send, table, session) {
  if (table.phase !== "playing" || !table.hand) {
    return;
  }
  sendSnapshot(send, table, session);
}

function sendSnapshot(send, table, session) {
  const hand = table.hand;
  send(PUSH.NIUNIU_INNING_BEGIN_INFO, {
    gameState: hand.street,
    gameStateStartTime: Date.now(),
    pot: hand.pot,
    uidList: live(table).map((m) => m.uid),
    currentOperatorId: hand.actorUid,
    leftTime: Math.max(0, Math.floor((hand.deadline - Date.now()) / 1000)),
    currentInning: table.currentInning,
    flopPokerList: hand.board.slice(0, 3),
    turnPoker: hand.board[3] ?? -1,
    memberDeskInfos: table.members.map((m) => ({
      state: m.folded ? 3 : 1,
      xiaZhuData: m.totalBet,
      banker: m.dealer,
      lastOperation: m.lastOperation,
      pos: m.pos,
      uid: m.uid,
      handPais: session.userId === m.uid ? m.hole : [-1, -1],
    })),
  });
}

function settle(io, table, contenders) {
  const hand = table.hand;
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "SETTLE");
  const active = contenders.filter((m) => !m.folded);
  const ranked = active.map((m) => ({
    member: m,
    eval: hand.board.length === 5 ? evaluate7([...m.hole, ...hand.board]) : { cardTypeId: 1, key: [0], pokerEnumList: m.hole.map(cardName), best5: m.hole },
  }));
  ranked.sort((a, b) => compareRank(b.eval, a.eval));
  const winners = ranked.filter((r) => compareRank(r.eval, ranked[0].eval) === 0);
  const winEach = Math.floor(hand.pot / winners.length);
  const results = table.members.filter((m) => m.hole?.length).map((m) => {
    const row = ranked.find((r) => r.member.uid === m.uid);
    const won = winners.some((w) => w.member.uid === m.uid);
    const score = won ? winEach - m.totalBet : -m.totalBet;
    if (won) {
      m.point += winEach;
    }
    const evals = row?.eval;
    return {
      xiaZhuData: m.totalBet,
      cardTypeInfo: evals ? {
        pokerEnumList: evals.pokerEnumList,
        handCardList: evals.best5,
        cardTypeId: evals.cardTypeId,
      } : { pokerEnumList: [], handCardList: m.hole, cardTypeId: 0 },
      cardTypeId: evals?.cardTypeId || 0,
      insuranceBet: 0,
      insuranceProfit: 0,
      isWin: won,
      uid: m.uid,
      score,
      point: m.point,
      handPais: table.forceShowCard || !m.folded ? [...m.hole, ...hand.board] : [],
      showCards: table.forceShowCard || !m.folded ? m.hole : [],
      pos: m.pos,
    };
  });
  const replayPlayers = table.members.filter((m) => m.hole?.length).map((m) => {
    const result = results.find((item) => item.uid === m.uid);
    const userInfo = userInfoOf(m);
    return {
      uid: m.uid,
      userName: m.name,
      userIcon: userInfo.icon,
      pos: m.pos,
      score: result?.score || 0,
      isWin: Boolean(result?.isWin),
      openingPoint: m.openingPoint,
      cardTypeId: result?.cardTypeId || 0,
      cardTypeInfo: result?.cardTypeInfo,
      posName: m.posName,
      cards: [...m.hole, ...hand.board],
      handPais: [...m.hole],
      commonPoker: [...hand.board],
      showCards: Array.isArray(result?.showCards) && result.showCards.length
        ? result.showCards.slice(0, 2)
        : [-1, -1],
      operateList: hand.replayActions
        .filter((action) => action.uid === m.uid)
        .map(({ uid, replayOrder, ...action }) => action),
    };
  });
  table.history ||= [];
  // Dev replay is room-local; keep every completed hand until the room is retired.
  table.history.push({
    gameRoomId: table.roomId,
    currentInningNum: table.currentInning,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
    pot: hand.pot,
    forceShowCard: Boolean(table.forceShowCard),
    firstGameList: replayPlayers,
    secondGameList: [],
    roundEvents: hand.replayEvents.map((event) => ({
      ...event,
      ...(Array.isArray(event.cards) ? { cards: event.cards.slice() } : {}),
      ...(Array.isArray(event.board) ? { board: event.board.slice() } : {}),
    })),
  });
  io.broadcast(PUSH.DZPK_PLAYER_DIPAI_PUSH, active.map((m) => ({ uid: m.uid, cardList: m.hole, pos: m.pos })));
  io.broadcast(PUSH.DZPK_INNING_RESULT_PUSH, results);
  // ROOM_INFO is wired to the client's room-login handler, which stops all
  // running actions and resets the table. The result payload already carries
  // each player's new point, so do not interrupt the settlement animation.
  table.hand = null;
  table.phase = seated(table).length >= 2 ? "starting" : "idle";
  table.startAt = Date.now() + gameConfig.nextHandDelayMs;
}

export function foldIfPlaying(io, table, uid) {
  const member = table.members.find((m) => m.uid === uid);
  if (!member || table.phase !== "playing" || !table.hand || member.folded) {
    return;
  }
  if (table.hand.actorUid === uid) {
    applyAction(io, table, uid, OP.ABANDON, 0);
    return;
  }
  member.folded = true;
  member.lastOperation = OP.ABANDON;
  const remaining = live(table);
  if (remaining.length === 1) {
    settle(io, table, remaining);
  }
}

export function onTexasStandup(io, table, session) {
  const uid = session.userId;
  const member = table.members.find((m) => m.uid === uid);
  if (!member) {
    return 0;
  }
  foldIfPlaying(io, table, uid);
  const cash = member.point || 0;
  table.members = table.members.filter((m) => m.uid !== uid);
  if (!table.members.some((m) => !m.bot)) {
    table.members = table.members.filter((m) => !m.bot);
    table.phase = "idle";
    table.hand = null;
  }
  io.broadcast(PUSH.USER_STANDUP_ROOM, uid);
  io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
  io.broadcast(PUSH.ROOM_INFO, texasRoomInfo(table));
  return cash;
}
