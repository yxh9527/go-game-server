import { makeDeck, shuffle } from "../holdem/cards.js";
import { rel } from "../../rel.js";
import { env } from "../../../../shared/rpc/env.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { default: gameConfig } = await rel(import.meta.url, "./config.js", version);
const { compareWithSuit: compare3, evaluate3 } = await rel(import.meta.url, "./hand.js", version);
const { ZJH_OP: OP, ZJH_PUSH: MSG } = await rel(import.meta.url, "./messages.js", version);
const { PUSH } = await rel(import.meta.url, "../../messages.js", version);
const { userInfoOf, memberListSeats } = await rel(import.meta.url, "../../core/member.js", version);
const robot = await rel(import.meta.url, "./robot.js", version);
const features = await rel(import.meta.url, "../../core/room-features.js", version);
const fair = await rel(import.meta.url, "../../core/fair-code.js", version);
const lifecycle = await rel(import.meta.url, "../../core/room-lifecycle.js", version);
const { awardPots } = await rel(import.meta.url, "../holdem/pots.js", version);
const history = env.isDev ? await rel(import.meta.url, "../../../../cache/zjh/history.js", version) : null;
export const { botChoose } = robot;
const hidden = () => [-1, -1, -1];

export function ctjhParams(table) {
  return {
    ante: table.ante, initialBet: table.ante, smallBlind: 0, bigBlind: 0,
    allInRepetCard: false, delayLook: false, openInsurance: false, openMen: false,
    forceShowCard: table.forceShowCard, forceShowType: 1,
    compareRule: 1, maxRounds: table.maxRounds, maxSingleBet: 0,
    mustMenRound: 1, compareRound: 0, compareTime: 2, allowCompareMen: false,
    jinHuaTime: 0, baoZiTime: 0, criticalFlag: false, criticalAnte: 0,
    carryMin: table.carryMin, carryMax: -1, carryDefault: table.carryMin,
    betTime: table.betTime, gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
    gameName: table.cfg?.name || gameConfig.name, gameStartNum: 2,
    observed: true, randomSit: false, openAuditCarry: false,
    banTalk: false, banEmulator: false, taxType: 0, taxPercent: 0, openTaxNoLimit: true,
  };
}

export function zjhConf(table) {
  return { roomType: gameConfig.confRoomType, ctjhParams: ctjhParams(table),
    minPeople: gameConfig.minPeople, maxPeople: gameConfig.maxPeople,
    playMode: table.playMode || 3, allowCarryOut: true, hundredSwitch: false,
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || 2501),
    roomClassification: table.roomClassification || 2 };
}

export function extraRoomInfo(table) {
  const memberList = memberListSeats(table.members, gameConfig.maxPeople);
  // 3260 subtracts this hand's xiaZhuData during original-client reconstruction.
  if (table.hand) for (const seat of memberList) {
    const player = participants(table).find((p) => p.uid === seat.uid);
    if (player) seat.point += player.totalBet;
  }
  return { ctjh: ctjhParams(table), playMode: table.playMode || 3,
    roomClassification: table.roomClassification || 2, delayLeftCount: 0,
    chatHistory: [], disusePoint: table.carryMin, memberList };
}

const seated = (table) => table.members.filter((m) => m.point > 0 && !m.carryDeadline);
export const participants = (table) => table.hand?.participants || table.hand?.statsPlayers || [];
const live = (table) => participants(table).filter((m) => !m.folded);
const actorOf = (table) => live(table).find((m) => m.uid === table.hand?.actorUid);
const sendUser = (io, uid, id, data) => {
  if (io.sendUser) io.sendUser(uid, id, data);
  else io.forEachPlayer?.((s) => { if (Number(s.userId) === Number(uid)) io.send(s.ws, id, data); });
};

export function beginHand(io, table) {
  if (table.hand || lifecycle.isExpired(table)) return;
  const players = seated(table).sort((a, b) => a.pos - b.pos);
  if (players.length < 2) { table.phase = "idle"; return; }
  const dealer = players.find((p) => p.pos > table.dealerPos) || players[0];
  table.dealerPos = dealer.pos;
  const first = players.find((p) => p.pos > dealer.pos) || players[0];
  table.phase = "playing";
  table.roomState = 2;
  table.currentInning += 1;
  for (const p of players) Object.assign(p, { dealer: p === dealer, folded: false,
    looked: false, hole: [], streetBet: 0, totalBet: 0, lastOperation: 0,
    openingPoint: p.point, selectedShow: [], followAlways: false, preFold: false,
    blindBet: 0, seenBet: 0 });
  table.hand = { participants: players, deck: shuffle(makeDeck()), deckPos: 0,
    pot: 0, currentBet: table.ante, round: 1, actorUid: first.uid,
    acted: new Set(), bankerId: dealer.uid, firstUid: first.uid, events: [],
    viewers: new Set([...players, ...(table.observers || [])].map((p) => Number(p.uid))) };
  features.beginHandStats(table, players);
  io.broadcast(PUSH.NIUNIU_CURRENT_INNING_BEGIN_INFO, { currentInning: table.currentInning,
    uidList: players.map((p) => p.uid), playMode: table.playMode, initialBet: table.ante,
    smallBlind: 0, bigBlind: 0 });
  fair.beginFairHand(io, table, players, 3);
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_FRONT");
  for (const p of players) pay(io, table, p, OP.ANTE, Math.min(p.point, table.ante), 0);
  io.broadcast(MSG.ZHUANG, { bankerId: dealer.uid, bankerPos: dealer.pos,
    smallBlindId: 0, bigBlindId: 0, straddleUid: 0, underTheGunUid: first.uid });
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "DEAL_PERFLOP");
  for (const p of players) { p.hole = table.hand.deck.slice(table.hand.deckPos, table.hand.deckPos + 3); table.hand.deckPos += 3; }
  io.broadcast(MSG.DEAL_DI, players.map((p) => ({ uid: p.uid, cardList: hidden() })));
  io.broadcast(MSG.ROUND_INFO, 1);
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "BET_PERFLOP");
  prompt(io, table);
}

export function callAmount(table, player) {
  return table.hand.currentBet * (player.looked ? 2 : 1);
}

export function actionOptions(table, player) {
  const score = callAmount(table, player);
  const item = (operation, amount = 0, isEnable = true) => ({ operation, data: { score: amount, isEnable } });
  const opts = [item(OP.FOLD), item(OP.CALL, score, player.point >= score),
    item(OP.RAISE, score * 2, player.point >= score * 2)];
  if (!player.looked && table.hand.round > ctjhParams(table).mustMenRound) opts.push(item(OP.LOOK));
  opts.push(item(OP.COMPARE, score * 2, table.hand.round > 1 && player.looked
    && player.point >= score * 2 && live(table).length > 1));
  if (player.point < score) opts.push(item(OP.ALL_IN, player.point, player.point > 0));
  else opts.push(item(OP.FOLLOW_ALWAYS, score));
  return opts;
}

function turnPayload(table) {
  return { uid: table.hand.actorUid, leftTime: Math.max(0, (table.hand.deadline - Date.now()) / 1000),
    buyDelayCount: 0, delayLeftCount: 0, isByDelay: false };
}

function preOptions(table, p) {
  // 3780 opens the waiting-player panel in the original client. Sending it
  // after 3726 to the actor overlays that panel on the actual action buttons.
  if (!p || p.uid === table.hand?.actorUid || p.folded || p.point <= 0) return null;
  return [
    { operation: OP.FOLLOW_ALWAYS, data: { score: 0, isEnable: Boolean(p.followAlways) } },
    { operation: OP.FOLD, data: { score: 0, isEnable: Boolean(p.preFold) } },
  ];
}

function pushPre(io, table, p) {
  const options = preOptions(table, p);
  if (options) sendUser(io, p.uid, MSG.PRE_OPERATION, options);
}

function prompt(io, table, resetClock = true) {
  const actor = actorOf(table);
  if (!actor || live(table).length < 2) return settle(io, table);
  if (actor.point <= 0) return nextActor(io, table, actor);
  if (resetClock) table.hand.deadline = Date.now() + table.betTime * 1000;
  robot.scheduleTurn(table, actor);
  io.broadcast(MSG.OPERATION_PLAYER, turnPayload(table));
  sendUser(io, actor.uid, MSG.OPERATION, actionOptions(table, actor));
  for (const p of live(table)) pushPre(io, table, p);
}

function pushBet(io, table, p, operation, amount, round = table.hand.round) {
  p.lastOperation = operation;
  const data = { uid: p.uid, currentBetScore: amount, totalBetScore: p.totalBet,
    totalBetScoreMen: p.blindBet || 0, totalBetScoreNotMen: p.seenBet || 0,
    operation, point: p.point, pot: table.hand.pot };
  io.broadcast(MSG.ACTION_BET, data);
  table.hand.events ||= [];
  table.hand.events.push({ ...data, operationType: operation, currentRounds: round,
    gameState: round === 0 ? 1 : 4, bet: amount, roundBetScore: amount });
}

function pay(io, table, p, op, amount, round) {
  p.point -= amount; p.totalBet += amount; p.streetBet = amount;
  table.hand.pot += amount;
  if (p.looked) p.seenBet = (p.seenBet || 0) + amount;
  else p.blindBet = (p.blindBet || 0) + amount;
  pushBet(io, table, p, op, amount, round);
}

export function onZjhAction(io, table, session, body) {
  const uid = Number(session.userId);
  if (body.uid != null && Number(body.uid) !== uid) return;
  return applyAction(io, table, uid, Number(body.operation), body.operationData, body.targetUid);
}

function applyAction(io, table, uid, op, data, targetUid) {
  if (table.phase !== "playing" || !table.hand) return false;
  const p = live(table).find((m) => m.uid === uid);
  if (!p || p.point <= 0) return false;
  if (op === OP.FOLLOW_ALWAYS) {
    p.followAlways = !p.followAlways; p.preFold = false; pushPre(io, table, p);
    return true;
  }
  if (op === OP.FOLD && uid !== table.hand.actorUid) {
    p.preFold = !p.preFold; p.followAlways = false; pushPre(io, table, p); return true;
  }
  if (op === OP.LOOK) {
    if (p.looked || table.hand.round <= ctjhParams(table).mustMenRound) return false;
    p.looked = true;
    pushBet(io, table, p, OP.LOOK, 0);
    sendUser(io, p.uid, MSG.SEE_CARD, { uid: p.uid, holeCardList: p.hole.slice(), cardTypeInfo: evaluate3(p.hole) });
    prompt(io, table, false);
    return true;
  }
  if (uid !== table.hand.actorUid) return false;
  const option = actionOptions(table, p).find((o) => o.operation === op && o.data.isEnable);
  if (!option) return false;
  if (op === OP.CALL || op === OP.RAISE) {
    if (data != null && (!Number.isFinite(Number(data))
      || Math.abs(Number(data) * 100 - option.data.score) > 0.000001)) return false;
  }
  if (op === OP.FOLD) { p.folded = true; pushBet(io, table, p, op, 0); }
  else if (op === OP.COMPARE) {
    const target = live(table).find((m) => m.uid === Number(targetUid) && m !== p);
    if (!target) return false;
    pay(io, table, p, op, option.data.score);
    // compareRule=1 resolves equal ranks by suit, as named in the original client.
    const winner = compare3(evaluate3(p.hole), evaluate3(target.hole)) > 0 ? p : target;
    const loser = winner === p ? target : p;
    loser.folded = true;
    const comparison = { uid, target: target.uid, winner: winner.uid, isLast: live(table).length === 1 };
    Object.assign(table.hand.events.at(-1), { targetUid: target.uid, winUid: winner.uid, ...comparison });
    io.broadcast(MSG.BIPAI_RESULT, comparison);
    pushBet(io, table, loser, OP.DISUSE, 0);
  } else {
    pay(io, table, p, op, option.data.score);
    if (op === OP.RAISE) table.hand.currentBet *= 2;
  }
  nextActor(io, table, p);
  return true;
}

function nextActor(io, table, from) {
  if (live(table).length < 2) return settle(io, table);
  const active = live(table).filter((p) => p.point > 0);
  if (!active.length) return settle(io, table);
  const hand = table.hand;
  hand.acted ||= new Set();
  hand.acted.add(from.uid);
  if (active.every((p) => hand.acted.has(p.uid))) {
    if (hand.round >= table.maxRounds || active.length < 2) return settle(io, table);
    hand.round += 1;
    hand.acted.clear();
    io.broadcast(MSG.ROUND_INFO, hand.round);
  }
  const order = active.slice().sort((a, b) => a.pos - b.pos);
  const next = order.find((p) => p.pos > from.pos) || order[0];
  hand.actorUid = next.uid;
  prompt(io, table);
}

export function tickPlaying(io, table, now = Date.now()) {
  if (table.phase !== "playing" || !table.hand) return;
  const p = actorOf(table);
  if (!p) return settle(io, table);
  if (p.preFold) { applyAction(io, table, p.uid, OP.FOLD); return; }
  if (p.followAlways) {
    const op = p.point >= callAmount(table, p) ? OP.CALL : OP.ALL_IN;
    applyAction(io, table, p.uid, op); return;
  }
  if (robot.tickBot(table, p, now, (uid, op, data, target) => applyAction(io, table, uid, op, data, target))) return;
  if (now >= table.hand.deadline) applyAction(io, table, p.uid, OP.FOLD);
}

function settle(io, table) {
  const hand = table.hand;
  if (!hand || hand.settled) return;
  hand.settled = true;
  const players = participants(table);
  const ranked = live(table).map((p) => ({ member: p, eval: evaluate3(p.hole) }))
    .sort((a, b) => compare3(b.eval, a.eval));
  const payouts = new Map(players.map((p) => [p.uid, 0]));
  if (players.some((p) => !p.folded && p.point === 0) && ranked.length > 1) {
    const result = awardPots(players, ranked, hand.bankerId, compare3);
    for (const [uid, amount] of result.payout) payouts.set(uid, amount);
  } else {
    const winners = ranked.filter((r) => compare3(r.eval, ranked[0].eval) === 0);
    const order = winners.sort((a, b) => ((a.member.pos - table.dealerPos + gameConfig.maxPeople - 1) % gameConfig.maxPeople)
      - ((b.member.pos - table.dealerPos + gameConfig.maxPeople - 1) % gameConfig.maxPeople));
    order.forEach((r, i) => payouts.set(r.member.uid, Math.floor(hand.pot / order.length) + (i < hand.pot % order.length ? 1 : 0)));
  }
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, "SETTLE");
  const results = players.map((p) => {
    const won = payouts.get(p.uid) || 0;
    p.point += won;
    const publicCards = table.forceShowCard || (ranked.length > 1 && !p.folded);
    const cards = publicCards ? p.hole.slice() : p.hole.map((card) => p.selectedShow?.includes(card) ? card : -1);
    const visible = cards.every((c) => c >= 0);
    const user = userInfoOf(p);
    if (visible) io.broadcast(MSG.SHOWCARD, { uid: p.uid, pos: p.pos,
      holeCardList: cards, cardTypeInfo: evaluate3(cards) });
    return { uid: p.uid, name: user.name, icon: user.icon, pos: p.pos, banker: p.dealer,
      xiaZhuData: p.totalBet, score: won - p.totalBet, point: p.point, isWin: won > 0,
      handPais: visible ? cards.slice() : [], showCards: cards,
      cardTypeId: visible ? evaluate3(cards).cardTypeId : -1,
      playerStatus: p.folded ? 2 : 0, secondCardTypeId: 0,
      insuranceBet: 0, insuranceProfit: 0, winInsurance: 0,
      raiseMultiple: 0, multipleAnte: 0, totalScore: 0, finallyScore: 0, take: 0 };
  });
  features.finishHandStats(table, results);
  fair.finishFairHand(table, results);
  if (io.env !== "prod") history?.recordHand(table, hand, results, zjhConf(table));
  io.broadcast(MSG.INNING_RESULT, results);
  features.pushRanking({ table, io });
  table.hand = null;
  table.roomState = 1;
  table.phase = seated(table).length >= 2 ? "starting" : "idle";
  table.startAt = Date.now() + gameConfig.nextHandDelayMs;
}

export function foldIfPlaying(io, table, uid) {
  const p = live(table).find((m) => m.uid === uid);
  if (!p || !table.hand) return;
  p.folded = true;
  pushBet(io, table, p, OP.FOLD, 0);
  if (live(table).length < 2) settle(io, table);
  else if (table.hand.actorUid === uid) nextActor(io, table, p);
}

export function onHandCardReq(send, table, session) {
  const p = participants(table).find((p) => p.uid === Number(session.userId));
  send(PUSH.DZPK_HAND_CARD_RES, { handCard: p?.looked ? p.hole.slice() : hidden(), commonCard: [] });
}

export function onShowCardReq(send, table, session, body) {
  const p = participants(table).find((p) => p.uid === Number(session.userId));
  const valid = p?.looked && p.hole.includes(body.card) && typeof body.isShow === "boolean";
  if (valid) {
    const cards = new Set(p.selectedShow || []);
    if (body.isShow) cards.add(body.card); else cards.delete(body.card);
    p.selectedShow = [...cards];
  }
  send(PUSH.DZPK_SHOW_CARD_RES, { result: valid ? 0 : 1, card: body.card, isShow: Boolean(body.isShow) });
}

export function pushPlayingSnapshot(send, table, session) {
  const hand = table.hand;
  if (!hand) return;
  hand.viewers ||= new Set(participants(table).map((p) => Number(p.uid)));
  hand.viewers.add(Number(session.userId));
  fair.watchFairHand(table, session.userId);
  send(PUSH.NIUNIU_INNING_BEGIN_INFO, { currentInning: table.currentInning,
    uidList: participants(table).map((p) => p.uid), gameState: "BET_PERFLOP",
    memberDeskInfos: participants(table).map((p) => ({ uid: p.uid, pos: p.pos, state: 3,
      banker: p.dealer, xiaZhuData: p.totalBet, lastOperation: p.lastOperation,
      isLooked: p.looked, isShow: false,
      handPais: p.uid === Number(session.userId) && p.looked ? p.hole.slice() : hidden(),
      showCards: hidden() })),
    pot: hand.pot, roundBetMap: Object.fromEntries(participants(table).map((p) => [p.uid, p.totalBet])),
    currentOperatorId: hand.actorUid, leftTime: turnPayload(table).leftTime,
    buyDelayCount: 0, delayLeftCount: 0, smallBlindId: 0, bigBlindId: 0, straddleUid: 0,
    underTheGunUid: hand.firstUid || hand.actorUid, flopPokerList: [], turnPoker: -1, riverPoker: -1,
    finalBetPlayerId: 0, finalBetPlayerPoint: 0 });
  send(MSG.ROUND_INFO, hand.round);
  send(MSG.OPERATION_PLAYER, turnPayload(table));
  if (Number(session.userId) === hand.actorUid) send(MSG.OPERATION, actionOptions(table, actorOf(table)));
  else {
    const options = preOptions(table, participants(table).find((p) => p.uid === Number(session.userId)));
    if (options) send(MSG.PRE_OPERATION, options);
  }
}

export function historyPayload(table, request = {}, uid) {
  return history?.historyPayload(table, request, uid) || { gameRoomId: table.roomId,
    roomTypeName: "ctjh", blind: JSON.stringify({ ante: table.ante }),
    totalNum: 0, beginNum: 0, endNum: 0, playBackList: [], isOfflineData: false };
}
export const historyDetail = (...args) => history?.historyDetail(...args) || null;
