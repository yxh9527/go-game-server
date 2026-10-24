import { makeDeck, shuffle } from "../holdem/cards.js";
import gameConfig from "./config.js";
import { compare3, evaluate3 } from "./hand.js";
import { ZJH_OP, ZJH_PUSH } from "./messages.js";
import { rel } from "../../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { PUSH } = await rel(import.meta.url, "../../messages.js", version);
const robot = await rel(import.meta.url, "./robot.js", version);
const features = await rel(import.meta.url, "../../core/room-features.js", version);
const fair = await rel(import.meta.url, "../../core/fair-code.js", version);
const lifecycle = await rel(import.meta.url, "../../core/room-lifecycle.js", version);
export const { ensureBot, botChoose } = robot;

export function zjhConf(table) {
  return {
    roomType: gameConfig.confRoomType,
    ctjhParams: {
      ante: table.ante,
      allInRepetCard: false,
      delayLook: false,
      openInsurance: false,
      openMen: false,
      forceShowCard: table.forceShowCard,
      forceShowType: table.forceShowCard ? 1 : 0,
      compareRule: 1,
      maxRounds: table.maxRounds,
      maxSingleBet: 0,
      mustMenRound: 1,
      compareRound: 0,
      compareTime: 2,
      allowCompareMen: false,
      jinHuaTime: 0,
      baoZiTime: 0,
      criticalFlag: false,
      criticalAnte: 0,
      carryMin: table.carryMin,
      betTime: table.betTime,
      gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
    },
    playMode: table.playMode || 3,
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || 2501),
    roomClassification: 2,
  };
}

export function extraRoomInfo(table) {
  return {
    ctjh: {
      gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
      gameName: gameConfig.name,
      ante: table.ante,
      carryMin: table.carryMin,
      forceShowCard: table.forceShowCard,
      maxRounds: table.maxRounds,
    },
  };
}

function seated(table) {
  return table.members.filter((m) => m.point > 0);
}

function live(table) {
  return table.members.filter((m) => !m.folded && m.hole?.length);
}

function currentActor(table) {
  return table.members.find((m) => m.uid === table.hand?.actorUid) || null;
}

export function beginHand(io, table) {
  if (lifecycle.isExpired(table)) return;
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
  const utg = players[(table.dealerPos + 1) % players.length];
  for (const m of table.members) {
    m.dealer = m.uid === dealer.uid;
    m.folded = false;
    m.looked = false;
    m.hole = [];
    m.streetBet = 0;
    m.totalBet = 0;
    m.lastOperation = 0;
  }
  const deck = shuffle(makeDeck());
  table.hand = {
    deck,
    deckPos: 0,
    pot: 0,
    currentBet: table.ante,
    round: 1,
    actorUid: utg.uid,
    acted: new Set(),
    deadline: Date.now() + table.betTime * 1000,
    bankerId: dealer.uid,
  };
  features.beginHandStats(table, players);
  fair.beginFairHand(io, table, players, 3);
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FRONT");
  for (const p of players) {
    const pay = Math.min(p.point, table.ante);
    p.point -= pay;
    p.streetBet += pay;
    p.totalBet += pay;
    p.lastOperation = ZJH_OP.ANTE;
    table.hand.pot += pay;
    io.broadcast(ZJH_PUSH.ACTION_BET, {
      uid: p.uid,
      currentBetScore: p.streetBet,
      totalBetScore: p.totalBet,
      totalBetScoreMen: 0,
      totalBetScoreNotMen: 0,
      operation: ZJH_OP.ANTE,
      point: p.point,
      pot: table.hand.pot,
    });
  }
  io.broadcast(ZJH_PUSH.ZHUANG, {
    bankerId: dealer.uid,
    smallBlindId: 0,
    bigBlindId: 0,
    straddleUid: 0,
    underTheGunUid: utg.uid,
    bankerPos: dealer.pos,
  });
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_PERFLOP");
  for (const p of players) {
    p.hole = [deck[table.hand.deckPos], deck[table.hand.deckPos + 1], deck[table.hand.deckPos + 2]];
    table.hand.deckPos += 3;
  }
  io.forEachPlayer((session) => {
    io.send(session.ws, ZJH_PUSH.DEAL_DI, players.map((p) => ({
      uid: p.uid,
      cardList: session.userId === p.uid ? p.hole : [-1, -1, -1],
    })));
  });
  io.broadcast(ZJH_PUSH.ROUND_INFO, { round: 1, maxRounds: table.maxRounds });
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_PERFLOP");
  promptActor(io, table);
}

function promptActor(io, table) {
  const actor = currentActor(table);
  if (!actor) {
    settle(io, table);
    return;
  }
  table.hand.deadline = Date.now() + table.betTime * 1000;
  robot.scheduleTurn(table, actor);
  io.broadcast(ZJH_PUSH.OPERATION_PLAYER, {
    uid: actor.uid,
    leftTime: table.betTime,
    buyDelayCount: 0,
    delayLeftCount: 0,
    isByDelay: false,
  });
  io.broadcast(ZJH_PUSH.OPERATION, actionOptions(table, actor));
  io.broadcast(ZJH_PUSH.PRE_OPERATION, actionOptions(table, actor).map((item) => ({
    operation: item.operation,
    data: { score: item.playerAmount, isEnable: true },
  })));
}

function actionOptions(table, actor) {
  const toCall = Math.max(0, table.hand.currentBet - actor.streetBet);
  const opts = [
    { operation: ZJH_OP.FOLD, data: 0, playerAmount: 0 },
    { operation: ZJH_OP.CALL, data: 0, playerAmount: Math.min(actor.point, toCall || table.ante) },
    { operation: ZJH_OP.RAISE, data: 1, playerAmount: Math.min(actor.point, (toCall || table.ante) * 2) },
  ];
  if (!actor.looked) {
    opts.push({ operation: ZJH_OP.LOOK, data: 0, playerAmount: 0 });
  }
  const rivals = live(table).filter((m) => m.uid !== actor.uid);
  if (rivals.length) {
    opts.push({ operation: ZJH_OP.COMPARE, data: rivals[0].uid, playerAmount: Math.min(actor.point, table.hand.currentBet) });
  }
  return opts;
}

export function onZjhAction(io, table, session, body) {
  if (table.phase !== "playing" || !table.hand) {
    return;
  }
  applyAction(io, table, Number(body?.uid || session.userId), Number(body?.operation), body?.operationData);
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
    applyAction(io, table, actor.uid, ZJH_OP.FOLD, 0);
  }
}

function applyAction(io, table, uid, operation, operationData) {
  const actor = currentActor(table);
  if (!actor || actor.uid !== uid) {
    return;
  }
  let op = operation;
  if (op === ZJH_OP.FOLD2) {
    op = ZJH_OP.FOLD;
  }
  if (op === ZJH_OP.LOOK) {
    actor.looked = true;
    actor.lastOperation = ZJH_OP.LOOK;
    io.forEachPlayer((session) => {
      if (session.userId === actor.uid) {
        io.send(session.ws, ZJH_PUSH.SHOWCARD, {
          uid: actor.uid,
          holeCardList: actor.hole,
          cardTypeInfo: evaluate3(actor.hole),
        });
      }
    });
    promptActor(io, table);
    return;
  }
  if (op === ZJH_OP.FOLD) {
    actor.folded = true;
    actor.lastOperation = ZJH_OP.FOLD;
    pushBet(io, table, actor, op);
    const remaining = live(table);
    if (remaining.length === 1) {
      settle(io, table);
      return;
    }
    nextActor(io, table, actor.uid);
    return;
  }
  if (op === ZJH_OP.COMPARE) {
    const targetId = Number(operationData);
    const target = live(table).find((m) => m.uid === targetId) || live(table).find((m) => m.uid !== actor.uid);
    const cost = Math.min(actor.point, table.hand.currentBet);
    actor.point -= cost;
    actor.streetBet += cost;
    actor.totalBet += cost;
    table.hand.pot += cost;
    actor.lastOperation = ZJH_OP.COMPARE;
    pushBet(io, table, actor, op);
    if (target) {
      const win = compare3(evaluate3(actor.hole), evaluate3(target.hole)) >= 0 ? actor : target;
      const lose = win.uid === actor.uid ? target : actor;
      lose.folded = true;
      io.broadcast(ZJH_PUSH.BIPAI_RESULT, {
        uid: actor.uid,
        target: target.uid,
        winner: win.uid,
        isLast: live(table).length === 1,
      });
    }
    if (live(table).length === 1) {
      settle(io, table);
      return;
    }
    nextActor(io, table, actor.uid);
    return;
  }
  const toCall = Math.max(table.ante, table.hand.currentBet - actor.streetBet);
  let pay = toCall;
  if (op === ZJH_OP.RAISE) {
    pay = Math.max(toCall * 2, toCall + table.ante);
  }
  pay = Math.min(actor.point, pay);
  actor.point -= pay;
  actor.streetBet += pay;
  actor.totalBet += pay;
  table.hand.pot += pay;
  if (actor.streetBet > table.hand.currentBet) {
    table.hand.currentBet = actor.streetBet;
    table.hand.acted = new Set([actor.uid]);
  } else {
    table.hand.acted.add(actor.uid);
  }
  actor.lastOperation = op;
  pushBet(io, table, actor, op);
  if (streetClosed(table) || table.hand.round >= table.maxRounds) {
    settle(io, table);
    return;
  }
  nextActor(io, table, actor.uid);
}

function streetClosed(table) {
  const actors = live(table).filter((m) => m.point > 0);
  if (actors.length <= 1) {
    return true;
  }
  return actors.every((m) => m.streetBet >= table.hand.currentBet && table.hand.acted.has(m.uid));
}

function nextActor(io, table, fromUid) {
  const order = live(table).sort((a, b) => a.pos - b.pos);
  const idx = order.findIndex((m) => m.uid === fromUid);
  for (let i = 1; i <= order.length; i += 1) {
    const m = order[(idx + i) % order.length];
    if (!m.folded) {
      if (i === order.length) {
        table.hand.round += 1;
        table.hand.acted = new Set();
        io.broadcast(ZJH_PUSH.ROUND_INFO, { round: table.hand.round, maxRounds: table.maxRounds });
      }
      table.hand.actorUid = m.uid;
      promptActor(io, table);
      return;
    }
  }
  settle(io, table);
}

function pushBet(io, table, player, operation) {
  io.broadcast(ZJH_PUSH.ACTION_BET, {
    uid: player.uid,
    currentBetScore: player.streetBet,
    totalBetScore: player.totalBet,
    totalBetScoreMen: 0,
    totalBetScoreNotMen: 0,
    operation,
    point: player.point,
    pot: table.hand.pot,
  });
}

function settle(io, table) {
  const hand = table.hand;
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "SETTLE");
  const remaining = live(table);
  const ranked = remaining.map((m) => ({ member: m, eval: evaluate3(m.hole) }));
  ranked.sort((a, b) => compare3(b.eval, a.eval));
  const winner = ranked[0]?.member;
  if (winner) {
    winner.point += hand.pot;
  }
  if (table.forceShowCard) {
    for (const m of remaining) {
      io.broadcast(ZJH_PUSH.SHOWCARD, {
        uid: m.uid,
        holeCardList: m.hole,
        cardTypeInfo: evaluate3(m.hole),
      });
    }
  }
  const results = table.members.filter((m) => m.hole?.length).map((m) => {
    const won = winner && m.uid === winner.uid;
    return {
      xiaZhuData: m.totalBet,
      banker: m.dealer,
      cardTypeId: m.hole.length ? evaluate3(m.hole).cardTypeId : 0,
      playerStatus: m.folded ? 2 : 0,
      isWin: won,
      uid: m.uid,
      score: won ? hand.pot - m.totalBet : -m.totalBet,
      point: m.point,
      handPais: m.hole,
      showCards: table.forceShowCard || won ? m.hole : [],
      pos: m.pos,
    };
  });
  features.finishHandStats(table, results);
  fair.finishFairHand(table, results);
  io.broadcast(ZJH_PUSH.INNING_RESULT, results);
  features.pushRanking({ table, io });
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
    applyAction(io, table, uid, ZJH_OP.FOLD, 0);
    return;
  }
  member.folded = true;
  if (live(table).length === 1) {
    settle(io, table);
  }
}
