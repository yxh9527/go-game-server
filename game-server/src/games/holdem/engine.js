import { PUSH } from "../../messages.js";
import { debit } from "../../wallet/index.js";
import { OP } from "./op.js";
import { cardName, compareRank, evaluate7, makeDeck, shuffle } from "./cards.js";
import gameConfig from "./config.js";

function num(row, key, fallback = 0) {
  const value = row?.[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

export function texasConf(table) {
  return {
    roomType: gameConfig.confRoomType,
    minPeople: gameConfig.minPeople,
    maxPeople: gameConfig.maxPeople,
    dzpkParams: {
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
      openAuditCarry: true,
      openTaxNoLimit: true,
    },
    playMode: table.playMode || 1,
    allowCarryOut: true,
    roomClassification: table.roomClassification,
    gameRoomConfigId: num(table.cfg, "game_room_config_id", 0),
  };
}

export function texasRoomInfo(table) {
  return {
    roomId: table.roomId,
    roomType: table.roomType,
    currentInning: table.currentInning,
    maxPeople: 7,
    roomState: table.phase === "playing" ? 2 : 1,
    memberList: table.members.map(publicMember),
    OBmemberList: table.observers,
    dzpk: {
      gameName: gameConfig.name,
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      carryMin: table.carryMin,
      forceShowCard: table.forceShowCard,
      openInsurance: false,
    },
    roomStart: table.members.length >= 2,
    memberNum: table.members.length,
  };
}

function publicMember(m) {
  return {
    uid: m.uid,
    name: m.name,
    pos: m.pos,
    point: m.point,
    state: m.folded ? 3 : m.state,
    lastOperation: m.lastOperation || 0,
    xiaZhuData: m.totalBet || 0,
    banker: Boolean(m.dealer),
  };
}

export function onTexasJoin(send, table, session, body) {
  const isOb = Boolean(body?.isOb);
  if (isOb) {
    if (!table.observers.some((item) => item.uid === session.userId)) {
      table.observers.push({ uid: session.userId, name: session.name, point: session.wallet });
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

export const BOT_UID = gameConfig.botUid;

export function ensureBot(table) {
  const humans = table.members.filter((m) => !m.bot);
  if (humans.length !== 1 || table.members.some((m) => m.bot)) {
    return;
  }
  const used = new Set(table.members.map((item) => item.pos));
  let pos = 0;
  while (used.has(pos) && pos < 7) {
    pos += 1;
  }
  table.members.push({
    uid: BOT_UID,
    name: gameConfig.botName,
    point: Math.max(table.carryMin, table.bigBlind * gameConfig.buyInBb),
    pos,
    state: 1,
    lastOperation: 0,
    totalBet: 0,
    dealer: false,
    bot: true,
  });
}

export function botChoose(table, actor) {
  const toCall = Math.max(0, table.hand.currentBet - actor.streetBet);
  if (toCall === 0) {
    return { operation: OP.PASS, operationData: 0 };
  }
  if (toCall >= actor.point) {
    return { operation: OP.ALL_IN, operationData: 0 };
  }
  if (toCall > table.bigBlind * 8) {
    return { operation: OP.ABANDON, operationData: 0 };
  }
  return { operation: OP.POT_1, operationData: 0 };
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
  if (actor.bot && now >= (table.hand.botActAt || 0)) {
    const choice = botChoose(table, actor);
    applyAction(io, table, actor.uid, choice.operation, choice.operationData);
    return;
  }
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
  for (const m of table.members) {
    m.dealer = m.uid === dealer.uid;
    m.folded = false;
    m.allIn = false;
    m.hole = [];
    m.streetBet = 0;
    m.totalBet = 0;
    m.lastOperation = 0;
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
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_BLIND");
  postBlind(io, table, sb, table.smallBlind, OP.BLIND);
  postBlind(io, table, bb, table.bigBlind, OP.BLIND);
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_PERFLOP");
  for (const p of players) {
    p.hole = [deck[table.hand.deckPos], deck[table.hand.deckPos + 1]];
    table.hand.deckPos += 2;
  }
  io.forEachPlayer((session) => {
    for (const p of players) {
      io.send(session.ws, PUSH.DZPK_DEAL_DI_PUSH, {
        uid: p.uid,
        cardList: session.userId === p.uid ? p.hole : [-1, -1],
      });
    }
    const self = players.find((p) => p.uid === session.userId);
    if (self) {
      io.send(session.ws, PUSH.DZPK_CARDTYPE_PUSH, holeType(self.hole));
    }
  });
  table.hand.street = "BET_PERFLOP";
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_PERFLOP");
  promptActor(io, table);
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
  pushAction(io, table, player, operation);
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
  const toCall = Math.max(0, hand.currentBet - actor.streetBet);
  let op = Number(operation);
  if (op === OP.PASS && toCall > 0) {
    op = OP.POT_1;
  }
  if (op === OP.POT_1 || op === OP.POT_4) {
    payTo(actor, hand, toCall);
    actor.lastOperation = OP.POT_1;
    if (actor.point === 0) {
      actor.allIn = true;
      actor.lastOperation = OP.ALL_IN;
    }
  } else if (op === OP.PASS) {
    actor.lastOperation = OP.PASS;
  } else if (op === OP.ABANDON) {
    actor.folded = true;
    actor.lastOperation = OP.ABANDON;
  } else if (op === OP.ALL_IN || op === OP.FOLLOW || op === OP.ADD || op === OP.BET) {
    const raiseTo = raiseAmount(table, actor, operationData);
    const pay = Math.min(actor.point, Math.max(0, raiseTo - actor.streetBet));
    payTo(actor, hand, pay);
    if (actor.streetBet > hand.currentBet) {
      hand.minRaise = actor.streetBet - hand.currentBet;
      hand.currentBet = actor.streetBet;
      hand.lastRaiseUid = actor.uid;
      hand.acted = new Set([actor.uid]);
    }
    actor.lastOperation = actor.point === 0 ? OP.ALL_IN : OP.FOLLOW;
    if (actor.point === 0) {
      actor.allIn = true;
    }
  } else {
    actor.lastOperation = op;
  }
  hand.acted.add(actor.uid);
  pushAction(io, table, actor, actor.lastOperation);
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

function payTo(player, hand, amount) {
  const pay = Math.min(player.point, Math.max(0, amount));
  player.point -= pay;
  player.streetBet += pay;
  player.totalBet += pay;
  hand.pot += pay;
}

function raiseAmount(table, actor, operationData) {
  const hand = table.hand;
  const data = Number(operationData || 0);
  let target;
  if (data >= 50) {
    target = data;
  } else if (data > 0) {
    target = Math.round(data * Math.max(hand.pot, table.bigBlind * 2));
  } else {
    target = hand.currentBet + hand.minRaise;
  }
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
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_FLOP");
    io.broadcast(PUSH.DZPK_DEAL_FAN_PUSH, { cardList: hand.board.slice(0, 3) });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FLOP");
  } else if (hand.street === "BET_FLOP") {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    hand.street = "BET_TURN";
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_TURN");
    io.broadcast(PUSH.DZPK_DEAL_ZHUANG_PUSH, { cardList: [hand.board[3]] });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_TURN");
  } else if (hand.street === "BET_TURN") {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    hand.street = "BET_RIVER";
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
  while (hand.board.length < 5) {
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
  }
}

function promptActor(io, table) {
  const actor = currentActor(table);
  if (!actor) {
    nextStreet(io, table);
    return;
  }
  table.hand.deadline = Date.now() + table.betTime * 1000;
  table.hand.botActAt = actor.bot ? Date.now() + gameConfig.botActDelayMs : 0;
  io.broadcast(PUSH.DZPK_OPERATION_PLAYER_PUSH, {
    uid: actor.uid,
    leftTime: table.betTime,
    buyDelayCount: 0,
    delayLeftCount: 0,
    isByDelay: false,
  });
  io.broadcast(PUSH.DZPK_OPERATION_PUSH, actionOptions(table, actor));
}

function actionOptions(table, actor) {
  const toCall = Math.max(0, table.hand.currentBet - actor.streetBet);
  const opts = [{ operation: OP.ABANDON, data: 0, playerAmount: 0 }];
  if (toCall === 0) {
    opts.push({ operation: OP.PASS, data: 0, playerAmount: 0 });
  } else {
    opts.push({ operation: OP.POT_1, data: 0, playerAmount: Math.min(actor.point, toCall) });
  }
  const minRaiseTo = table.hand.currentBet + table.hand.minRaise;
  if (actor.point > toCall) {
    opts.push({
      operation: OP.FOLLOW,
      data: 1,
      playerAmount: Math.min(actor.point, Math.max(0, minRaiseTo - actor.streetBet)),
    });
  }
  opts.push({ operation: OP.ALL_IN, data: 0, playerAmount: actor.point });
  return opts;
}

function pushAction(io, table, player, operation) {
  io.broadcast(PUSH.DZPK_ACTION_BET_PUSH, {
    uid: player.uid,
    currentBetScore: player.streetBet,
    totalBetScore: player.totalBet,
    operation,
    point: player.point,
    pot: table.hand.pot,
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
  io.broadcast(PUSH.DZPK_PLAYER_DIPAI_PUSH, active.map((m) => ({ uid: m.uid, cardList: m.hole, pos: m.pos })));
  io.broadcast(PUSH.DZPK_INNING_RESULT_PUSH, results);
  io.broadcast(PUSH.ROOM_INFO, texasRoomInfo(table));
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
