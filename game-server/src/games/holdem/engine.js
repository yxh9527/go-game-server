import { debit } from "../../wallet/index.js";
import { OP } from "./op.js";
import { cardName, compareRank, evaluate7, makeDeck, shuffle } from "./cards.js";
import gameConfig from "./config.js";
import { rel } from "../../rel.js";
import { env } from "../../../../shared/rpc/env.js";
import { REPLAY_GAME_STATE } from "./replay-state.js";
import { emptyHistoryPayload } from "./history-response.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { memberListSeats, publicObserver, publicSeat } = await rel(import.meta.url, "../../core/member.js", version);
const { PUSH } = await rel(import.meta.url, "../../messages.js", version);
const robot = await rel(import.meta.url, "./robot.js", version);
const features = await rel(import.meta.url, "../../core/room-features.js", version);
const fair = await rel(import.meta.url, "../../core/fair-code.js", version);
const lifecycle = await rel(import.meta.url, "../../core/room-lifecycle.js", version);
const { holdemRoomSettings, assertHoldemPlayable } = await rel(import.meta.url, "../../../../shared/holdem-room.js", version);
const { buildPots, awardPots } = await rel(import.meta.url, "./pots.js", version);
const { initializeCritical, nextHandRules } = await rel(import.meta.url, "./critical.js", version);
const localHistory = env.isDev
  ? await rel(import.meta.url, "../../../../cache/holdem/history.js", version)
  : null;
export const texasHistoryPayload = localHistory?.texasHistoryPayload || emptyHistoryPayload;
export const texasHistoryDetail = localHistory?.texasHistoryDetail || (() => null);
// Compatibility for existing callers; all robot behavior lives in robot.js.
export const { BOT_UID, ensureBots, ensureBot, botChoose } = robot;

function num(row, key, fallback = 0) {
  const value = row?.[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

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

export function createTexasTable(roomId, roomType, cfg) {
  assertHoldemPlayable(cfg, roomType);
  const table = lifecycle.initializeLifetime({
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
    ...holdemRoomSettings(cfg),
    criticalFlag: Number(roomType) !== 101 && holdemRoomSettings(cfg).criticalFlag,
    forceShowCard: holdemRoomSettings(cfg).forceShowCard,
    playMode: holdemPlayMode(cfg, roomType),
    roomClassification: holdemRoomSettings(cfg).roomClassification,
    betTime: gameConfig.betTime,
    dealerPos: 0,
    phase: "idle",
    startAt: 0,
    hand: null,
  });
  features.initializeRoomStats(table);
  initializeCritical(table);
  return table;
}

export function holdemPlayMode(cfg, roomType = cfg?.room_type) {
  const mode = holdemRoomSettings(cfg).playMode;
  // Cash hall selectors 0/2/8 correspond to room wire modes 1/3/9.
  return Number(roomType) !== 101 && [0, 2, 8].includes(mode) ? mode + 1 : mode;
}

export function dzpkParams(table) {
  return {
    gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.initialBet ?? table.bigBlind,
    straddle: table.straddle ?? false,
    criticalFlag: Boolean(table.criticalFlag),
    criticalAnte: table.criticalAnte ?? 100,
    criticalInterval: table.criticalInterval ?? '5-8',
    delayLook: true,
    openInsurance: false,
    forceShowCard: table.forceShowCard,
    forceShowType: 1,
    gameName: table.cfg?.name || gameConfig.name,
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
    gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
    leftTime: lifecycle.remainingSeconds(table),
    maxPeople: 7,
    roomState: table.phase === "playing" ? 2 : 1,
    memberList: memberListSeats(table.members, 7),
    OBmemberList: (table.observers || []).map((item) => publicObserver(item)),
    playMode: table.playMode,
    dzpk: dzpkParams(table),
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
  const report = features.ranking(table);
  send(PUSH.DZPK_PUSH_RANKINGLIST, report);
  send(PUSH.DZPK_PUSH_WATCHGAME, report.obMemberList);
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
  send(PUSH.DZPK_PUSH_RANKINGLIST, features.ranking(table));
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
  const uid = Number(session.userId);
  if (body?.uid != null && Number(body.uid) !== uid) return;
  applyAction(io, table, uid, Number(body?.operation), body?.operationData);
}

export function onHandCardReq(send, table, session) {
  const player = table.members.find((member) => Number(member.uid) === Number(session.userId));
  // The original client requests its own holes when its delayed turn starts.
  // Ignore any caller-supplied uid and never broadcast this response.
  send(PUSH.DZPK_HAND_CARD_RES, {
    handCard: table.hand && player?.hole?.length === 2 ? player.hole.slice() : [-1, -1],
    commonCard: table.hand?.board?.slice() || [],
  });
}

export function onShowCardReq(send, table, session, body) {
  const player = table.members.find((member) => Number(member.uid) === Number(session.userId));
  const card = body.card;
  const valid = table.phase === "playing" && table.hand && !table.forceShowCard
    && Number.isInteger(card) && player?.hole?.includes(card) && typeof body.isShow === "boolean";
  if (valid) {
    const selected = new Set(player.selectedShowCards || []);
    if (body.isShow) selected.add(card); else selected.delete(card);
    player.selectedShowCards = [...selected];
  }
  // Selection is private until settlement, matching the original card icon.
  send(PUSH.DZPK_SHOW_CARD_RES, { result: valid ? 0 : 1,
    card: Number.isInteger(card) ? card : -1, isShow: valid ? body.isShow : false });
}

export function beginHand(io, table) {
  if (lifecycle.isExpired(table)) return;
  const players = seated(table);
  if (players.length < 2) {
    table.phase = "idle";
    return;
  }
  const startTime = Date.now();
  const handRules = nextHandRules(table, startTime);
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
    m.selectedShowCards = [];
  }
  const deck = shuffle(makeDeck());
  table.hand = {
    ...handRules,
    startTime,
    deck,
    deckPos: 0,
    // Existing hands survive hot reload and retain their original deal layout.
    burnBeforeBoard: true,
    board: [],
    street: "BET_PERFLOP",
    pot: 0,
    currentBet: handRules.critical ? 0 : table.bigBlind,
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
    participants: players.slice(),
  };
  features.beginHandStats(table, players);
  fair.beginFairHand(io, table, players, 2);
  io.broadcast(PUSH.NIUNIU_CURRENT_INNING_BEGIN_INFO, {
    currentInning: table.currentInning,
    uidList: players.map((p) => p.uid),
    startTime,
    playMode: handRules.playMode,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: handRules.initialBet,
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
    postInitialBet(io, table, player, handRules.initialBet);
  }
  if (!handRules.critical) {
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_BLIND");
    postBlind(io, table, sb, table.smallBlind, OP.BLIND);
    postBlind(io, table, bb, table.bigBlind, OP.BLIND);
  }
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
  if (handRules.critical) {
    nextStreet(io, table);
    return;
  }
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
    dealRemaining(io, table);
    settle(io, table, livePlayers);
    return;
  }
  if (hand.street === "BET_PERFLOP") {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
    hand.board.push(hand.deck[hand.deckPos], hand.deck[hand.deckPos + 1], hand.deck[hand.deckPos + 2]);
    hand.deckPos += 3;
    hand.street = "BET_FLOP";
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_FLOP);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_FLOP");
    io.broadcast(PUSH.DZPK_DEAL_FAN_PUSH, { cardList: hand.board.slice(0, 3) });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FLOP");
  } else if (hand.street === "BET_FLOP") {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    hand.street = "BET_TURN";
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_TURN);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_TURN");
    io.broadcast(PUSH.DZPK_DEAL_ZHUANG_PUSH, { cardList: [hand.board[3]] });
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_TURN");
  } else if (hand.street === "BET_TURN") {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
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
  io.broadcast(PUSH.DZPK_BIANCHI_PUSH, buildPots(hand.participants || hand.statsPlayers || table.members).map((pot) => pot.amount));
  hand.actorUid = firstActorUid(table);
  if (!hand.actorUid) {
    nextStreet(io, table);
    return;
  }
  promptActor(io, table);
}

function dealRemaining(io, table) {
  const hand = table.hand;
  if (hand.board.length < 3) {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
    while (hand.board.length < 3) {
      hand.board.push(hand.deck[hand.deckPos]);
      hand.deckPos += 1;
    }
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_FLOP);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_FLOP");
    io.broadcast(PUSH.DZPK_DEAL_FAN_PUSH, { cardList: hand.board.slice(0, 3) });
  }
  if (hand.board.length < 4) {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_TURN);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_TURN");
    io.broadcast(PUSH.DZPK_DEAL_ZHUANG_PUSH, { cardList: [hand.board[3]] });
  }
  if (hand.board.length < 5) {
    if (hand.burnBeforeBoard) hand.deckPos += 1;
    hand.board.push(hand.deck[hand.deckPos]);
    hand.deckPos += 1;
    recordReplayDeal(hand, REPLAY_GAME_STATE.DEAL_RIVER);
    io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_RIVER");
    io.broadcast(PUSH.DZPK_DEAL_HE_PUSH, { cardList: [hand.board[4]] });
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
    playMode: hand.playMode ?? 0,
    initialBet: hand.initialBet ?? table.initialBet ?? table.bigBlind,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    gameState: hand.street,
    gameStateStartTime: Date.now(),
    pot: hand.pot,
    uidList: live(table).map((m) => m.uid),
    currentOperatorId: hand.actorUid,
    leftTime: Math.max(0, Math.floor((hand.deadline - Date.now()) / 1000)),
    currentInning: table.currentInning,
    flopPokerList: hand.board.slice(0, 3),
    turnPoker: hand.board[3] ?? -1,
    riverPoker: hand.board[4] ?? -1,
    roundBetMap: Object.fromEntries(table.members.map((m) => [m.uid, Number(m.streetBet) || 0])),
    sidePotList: buildPots(hand.participants || hand.statsPlayers || table.members).map((pot) => pot.amount),
    memberDeskInfos: table.members.map((m) => ({
      state: m.folded ? 3 : 1,
      xiaZhuData: m.totalBet,
      banker: m.dealer,
      lastOperation: m.lastOperation,
      pos: m.pos,
      uid: m.uid,
      handPais: Number(session.userId) === Number(m.uid) ? (m.hole || []) : [-1, -1],
      showCards: Number(session.userId) === Number(m.uid)
        ? (m.hole || []).map((card) => m.selectedShowCards?.includes(card) ? card : -1) : [-1, -1],
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
  const participants = hand.participants || hand.statsPlayers || table.members.filter((m) => m.hole?.length);
  const awards = awardPots(participants, ranked, hand.bankerId, compareRank);
  io.broadcast(PUSH.DZPK_BIANCHI_PUSH, awards.pots.map((pot) => pot.amount));
  const results = participants.map((m) => {
    const row = ranked.find((r) => r.member.uid === m.uid);
    const won = awards.winners.has(m.uid);
    const payout = awards.payout.get(m.uid) || 0;
    const score = payout - m.totalBet;
    m.point += payout;
    const evals = row?.eval;
    // Uncontested pots require no showdown. Folded holes must stay private
    // through every field, including the nested cardTypeInfo fallback.
    const reveal = table.forceShowCard || (active.length > 1 && !m.folded)
      || m.selectedShowCards?.length === 2;
    const shownEval = reveal && hand.board.length === 5
      ? (evals || evaluate7([...m.hole, ...hand.board])) : null;
    return {
      xiaZhuData: m.totalBet,
      ...(shownEval ? { cardTypeInfo: {
        pokerEnumList: shownEval.pokerEnumList,
        handCardList: shownEval.best5,
        cardTypeId: shownEval.cardTypeId,
      } } : {}),
      cardTypeId: shownEval?.cardTypeId || 0,
      insuranceBet: 0,
      insuranceProfit: 0,
      isWin: won,
      uid: m.uid,
      score,
      point: m.point,
      handPais: shownEval ? shownEval.best5 : [],
      showCards: reveal ? m.hole.slice() : m.selectedShowCards?.length
        ? m.hole.map((card) => m.selectedShowCards.includes(card) ? card : -1) : [],
      pos: m.pos,
    };
  });
  if (localHistory && io.env !== "prod") localHistory.recordHand(table, hand, results);
  const revealed = results.filter((result) => result.showCards.length === 2);
  if (revealed.length) {
    if (table.forceShowCard) {
      io.broadcast(PUSH.DZPK_PLAYER_DIPAI_PUSH, revealed.map((result) => ({ uid: result.uid, cardList: result.showCards, pos: result.pos })));
    } else {
      for (const result of revealed) io.broadcast(PUSH.DZPK_ACTION_SHOWCARD_PUSH,
        { uid: result.uid, cardList: result.showCards, pos: result.pos });
    }
  }
  features.finishHandStats(table, results);
  fair.finishFairHand(table, results);
  io.broadcast(PUSH.DZPK_INNING_RESULT_PUSH, results);
  features.pushRanking({ table, io });
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
  io.broadcast(PUSH.USER_STANDUP_ROOM, uid);
  io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
  io.broadcast(PUSH.ROOM_INFO, texasRoomInfo(table));
  return cash;
}
