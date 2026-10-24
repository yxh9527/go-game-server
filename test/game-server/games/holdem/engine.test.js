import assert from "node:assert/strict";
import test from "node:test";
import { beginHand, botChoose, createTexasTable, ensureBot, ensureBots, onGtoReq, onTexasAction, texasConf, texasHistoryDetail, texasHistoryPayload, texasRoomInfo, tickTexas } from "../../../../game-server/src/games/holdem/engine.js";
import { OP } from "../../../../game-server/src/games/holdem/op.js";
import { PUSH } from "../../../../game-server/src/messages.js";

function mockIo() {
  const messages = [];
  return {
    messages,
    send(_ws, msgid, payload) {
      messages.push({ msgid, payload, unicast: true });
    },
    broadcast(msgid, payload) {
      messages.push({ msgid, payload });
    },
    forEachPlayer() {},
  };
}

test("two seated players start a hand and fold ends it", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  table.phase = "starting";
  table.startAt = 0;
  const io = mockIo();
  tickTexas(io, table, 1);
  assert.equal(table.phase, "playing");
  assert.equal(table.currentInning, 1);
  assert.ok(table.hand.pot >= 30);
  const actor = table.hand.actorUid;
  onTexasAction(io, table, { userId: actor }, { uid: actor, operation: 6, operationData: 0 });
  assert.equal(table.phase, "starting");
  const resultIndex = io.messages.findIndex((message) => message.msgid === PUSH.DZPK_INNING_RESULT_PUSH);
  assert.ok(resultIndex >= 0);
  assert.equal(
    io.messages.slice(resultIndex + 1).some((message) => message.msgid === PUSH.ROOM_INFO),
    false,
    "a room snapshot after settlement resets the client's animation actions",
  );
  assert.ok(table.startAt - Date.now() > 5000, "the next hand must wait for the client settlement animation");
  assert.equal(table.history.length, 1);
  assert.equal(table.history[0].currentInningNum, 1);
  assert.ok(table.history[0].firstGameList.every((player) =>
    player.operateList.every((action) => Number.isInteger(action.gameState)
      && Number.isFinite(action.operationType)
      && Number.isFinite(action.currentBetScore)
      && Number.isFinite(action.totalBetScore)
      && Number.isFinite(action.pot))));
});

test("initial bets are collected before blinds and remain separate from the call amount", () => {
  const table = createTexasTable(700009, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const io = mockIo();

  beginHand(io, table);

  assert.deepEqual(table.members.map((player) => [player.pos, player.posName]).sort((a, b) => a[0] - b[0]), [
    [0, 3],
    [1, 1],
  ]);

  const actions = io.messages
    .filter((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH)
    .map((message) => message.payload);
  const initialBets = actions.filter((action) => action.operation === OP.PER);
  const blinds = actions.filter((action) => action.operation === OP.BLIND);
  assert.equal(initialBets.length, 2);
  assert.deepEqual(initialBets.map(({ currentBetScore, totalBetScore, pot }) => ({ currentBetScore, totalBetScore, pot })), [
    { currentBetScore: 20, totalBetScore: 20, pot: 20 },
    { currentBetScore: 20, totalBetScore: 20, pot: 40 },
  ]);
  assert.deepEqual(blinds.map(({ currentBetScore, totalBetScore, pot }) => ({ currentBetScore, totalBetScore, pot })), [
    { currentBetScore: 10, totalBetScore: 30, pot: 50 },
    { currentBetScore: 20, totalBetScore: 40, pot: 70 },
  ]);

  const visibleBets = new Map();
  for (const action of actions) {
    visibleBets.set(action.uid, (visibleBets.get(action.uid) || 0) + action.currentBetScore);
  }
  for (const player of table.members) {
    assert.equal(visibleBets.get(player.uid) - table.bigBlind, player.streetBet);
    assert.equal(player.totalBet, table.bigBlind + player.streetBet);
  }
  assert.equal(table.hand.pot, 70);
});

test("holdem replay records action order, deal streets, and client detail amounts", () => {
  const table = createTexasTable(700011, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 11, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 12, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const io = mockIo();
  beginHand(io, table);

  for (let count = 0; table.hand && count < 20; count += 1) {
    const actor = table.members.find((player) => player.uid === table.hand.actorUid);
    const operation = actor.streetBet < table.hand.currentBet ? OP.FOLLOW : OP.PASS;
    onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation, operationData: 0 });
  }

  const replay = table.history[0];
  assert.equal(table.hand, null);
  assert.ok(replay);
  assert.deepEqual(replay.roundEvents.map((event) => event.replayOrder), replay.roundEvents.map((_, index) => index));
  assert.deepEqual(replay.roundEvents.filter((event) => [5, 7, 9].includes(event.gameState)).map((event) => event.gameState), [5, 7, 9]);
  assert.ok(replay.firstGameList.every((player) => player.openingPoint === 1000 && Number.isInteger(player.posName)));

  const detail = texasHistoryDetail(table, 1).exploitsInfoMsgs[0];
  const rows = JSON.parse(detail.roundList);
  assert.deepEqual(rows.filter((row) => [5, 7, 9].includes(row.gameState)).map((row) => row.gameState), [5, 7, 9]);
  assert.equal(rows.find((row) => row.gameState === 5).flopPokerList.length, 3);
  assert.ok(rows.find((row) => row.gameState === 7).turnPoker >= 0);
  assert.ok(rows.find((row) => row.gameState === 9).riverPoker >= 0);
  assert.ok(rows.some((row) => row.operationType === OP.FOLLOW && row.roundBetScore > 0));
  assert.ok(rows.every((row, index) => index === 0 || rows[index - 1].pot <= row.pot));

  const playback = texasHistoryPayload(table, { roomId: table.roomId }).playBackList[0];
  assert.equal(Object.hasOwn(playback, "roundEvents"), false);
  assert.equal(Object.hasOwn(playback, "forceShowCard"), false);
  assert.ok(playback.firstGameList.every((player) => !Object.hasOwn(player, "openingPoint")));
});

test("non-finite raise amount is ignored and a later fold still settles the hand", () => {
  const table = createTexasTable(700005, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const first = { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, streetBet: 0, dealer: false, hole: [0, 1] };
  const second = { uid: 2, name: "b", point: 980, pos: 1, state: 1, lastOperation: 0, totalBet: 20, streetBet: 20, dealer: true, hole: [2, 3] };
  table.members.push(first, second);
  table.phase = "playing";
  table.hand = {
    currentBet: 20,
    minRaise: 20,
    pot: 30,
    actorUid: first.uid,
    street: "BET_PERFLOP",
    board: [],
    acted: new Set(),
    smallBlindId: first.uid,
  };
  const io = mockIo();

  onTexasAction(io, table, { userId: first.uid }, { uid: first.uid, operation: OP.ADD, operationData: "NaN" });

  assert.equal(first.point, 1000);
  assert.equal(first.totalBet, 0);
  assert.equal(first.streetBet, 0);
  assert.equal(table.hand.pot, 30);
  assert.equal(table.hand.actorUid, first.uid);
  assert.equal(io.messages.some((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH), false);

  onTexasAction(io, table, { userId: first.uid }, { uid: first.uid, operation: OP.ABANDON, operationData: 0 });

  const result = io.messages.find((message) => message.msgid === PUSH.DZPK_INNING_RESULT_PUSH);
  assert.ok(result);
  assert.equal(result.payload.find((row) => row.uid === second.uid).score, 10);
  assert.ok(result.payload.every((row) => Number.isFinite(row.score) && Number.isFinite(row.point)));
});

test("solo human gets a bot and bot checks when nothing to call", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push({ uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false });
  ensureBot(table, 1);
  assert.equal(table.members.length, 2);
  assert.equal(table.members[1].bot, true);
  table.hand = { currentBet: 0 };
  table.members[1].streetBet = 0;
  table.members[1].point = 1000;
  const choice = botChoose(table, table.members[1]);
  assert.equal(choice.operation, OP.PASS);
});

test("deal hole cards as a per-seat array", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  table.phase = "starting";
  table.startAt = 0;
  const messages = [];
  const io = {
    messages,
    send(_ws, msgid, payload) {
      messages.push({ msgid, payload, userId: _ws });
    },
    broadcast(msgid, payload) {
      messages.push({ msgid, payload });
    },
    forEachPlayer(fn) {
      fn({ userId: 1, ws: 1 });
      fn({ userId: 2, ws: 2 });
    },
  };
  tickTexas(io, table, 1);
  const deals = messages.filter((m) => m.msgid === PUSH.DZPK_DEAL_DI_PUSH);
  assert.equal(deals.length, 2);
  for (const m of deals) {
    assert.ok(Array.isArray(m.payload));
    assert.equal(m.payload.length, 2);
    const self = m.payload.find((p) => p.uid === m.userId);
    const other = m.payload.find((p) => p.uid !== m.userId);
    assert.equal(self.cardList.length, 2);
    assert.ok(self.cardList.every((c) => c >= 0));
    assert.deepEqual(other.cardList, [-1, -1]);
  }
});

test("texas conf exposes dzpk betTime for gameRoom.params", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const conf = texasConf(table);
  assert.equal(conf.hundredSwitch, false);
  assert.equal(conf.dzpk.betTime, table.betTime);
  assert.equal(conf.dzpk.carryMin, 500);
  assert.equal(conf.dzpk.carryMax, -1);
  assert.equal(conf.dzpk.initialBet, 20);
  assert.equal(conf.dzpkParams.betTime, table.betTime);
  assert.equal(conf.dzpk.delayLook, true);
  assert.equal(conf.dzpkParams.delayLook, true);
  assert.equal(conf.dzpk.openAuditCarry, false);
});

test("texas ROOM_INFO pads seven seats with userInfo", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 10001, name: "dev-10001", point: 2000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 90000001, name: "Bot", point: 2000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const info = texasRoomInfo(table);
  assert.equal(info.dzpk.smallBlind, 10);
  assert.equal(info.dzpk.bigBlind, 20);
  assert.equal(info.dzpk.initialBet, 20);
  assert.equal(info.maxPeople, 7);
  assert.equal(info.memberList.length, 7);
  assert.equal(info.memberList[0].pos, 0);
  assert.equal(info.memberList[0].userInfo.uid, 10001);
  assert.equal(info.memberList[1].userInfo.uid, 90000001);
  assert.equal(info.memberList[2].pos, 2);
  assert.equal(info.memberList[2].userInfo, undefined);
});

test("dev holdem history filters by room and inning and returns client replay shape", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({
    gameRoomId: 700000,
    currentInningNum: 3,
    pot: 90,
    firstGameList: [{
      uid: 1,
      userName: "a",
      score: 40,
      cardTypeId: 2,
      operateList: [{ operationType: OP.ALL_IN, currentBetScore: 50, totalBetScore: 50, pot: 90, gameState: 10, cards: [1, 2, 3] }],
    }],
    secondGameList: [],
  });
  const payload = texasHistoryPayload(table, { roomId: 700000, beginNum: 2, endNum: 2 });
  assert.equal(payload.gameRoomId, 700000);
  assert.equal(payload.totalNum, 3);
  assert.deepEqual(JSON.parse(payload.blind), {
    smallBlind: 10,
    bigBlind: 20,
    initialBet: 20,
    isStraddle: false,
  });
  assert.equal(payload.playBackList[0].currentInningNum, 3);
  assert.equal(payload.playBackList[0].firstGameList[0].operateList[0].operationType, OP.ALL_IN);
  assert.equal(texasHistoryPayload(table, { roomId: 700001, beginNum: 2, endNum: 2 }).totalNum, 0);
});

test("dev holdem history rows provide role, avatar, card stages, and hide unrevealed cards", () => {
  const table = createTexasTable(700014, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({
    gameRoomId: table.roomId,
    currentInningNum: 1,
    forceShowCard: false,
    firstGameList: [
      {
        uid: 10002,
        userName: "loser",
        pos: 2,
        posName: 3,
        score: -50,
        isWin: false,
        cardTypeId: 0,
        cardTypeInfo: { handCardList: [41, 42, 43, 44, 45] },
        cards: [51, 52, 1, 2, 3, 4, 5],
        handPais: [51, 52],
        commonPoker: [1, 2, 3, 4, 5],
        showCards: false,
        operateList: [{ operate: OP.ABANDON, operationType: OP.ABANDON, gameState: 4, cards: [51, 52, 1, 2, 3] }],
      },
      {
        uid: 10003,
        userName: "winner",
        pos: 0,
        posName: 1,
        score: 100,
        isWin: true,
        cardTypeId: 2,
        cardTypeInfo: { handCardList: [11, 12, 1, 2, 3] },
        cards: [11, 12, 1, 2, 3, 4, 5],
        handPais: [11, 12],
        commonPoker: [1, 2, 3, 4, 5],
        showCards: [11, 12],
        operateList: [{ operate: OP.ALL_IN, operationType: OP.ALL_IN, gameState: 4, cards: [11, 12, 1, 2, 3] }],
      },
    ],
    secondGameList: [],
  });

  const rows = texasHistoryPayload(table, { roomId: table.roomId, beginNum: 0, endNum: 0 }).playBackList[0].firstGameList;
  const loser = rows[0];
  const winner = rows[1];
  assert.equal(loser.posName, 3);
  assert.match(loser.userIcon, /^\/avator\/\d+\.(?:png|jpe?g|webp)$/);
  assert.equal(loser.isWin, false);
  assert.equal(loser.score, -50);
  assert.deepEqual(loser.showCards, [-1, -1]);
  assert.deepEqual(loser.handPais, []);
  assert.deepEqual(loser.cards.slice(0, 2), [-1, -1]);
  assert.deepEqual(loser.operateList.find((item) => item.gameState === 3).cards, [-1, -1]);
  assert.equal(loser.operateList.find((item) => item.operationType === OP.ABANDON).cards, undefined);

  assert.equal(winner.posName, 1);
  assert.equal(winner.userName, "winner");
  assert.equal(winner.isWin, true);
  assert.equal(winner.score, 100);
  assert.deepEqual(winner.showCards, [11, 12]);
  assert.deepEqual(winner.handPais, [11, 12, 1, 2, 3]);
  assert.deepEqual(winner.operateList.filter((item) => [3, 5, 7, 9].includes(item.gameState)).map((item) => item.gameState), [3, 5, 7, 9]);
});

test("legacy holdem history restores valid profile, position, and revealed cards", async () => {
  const { texasHistoryDetail } = await import("../../../../game-server/src/games/holdem/engine.js");
  const table = createTexasTable(700015, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({
    gameRoomId: table.roomId,
    currentInningNum: 1,
    forceShowCard: false,
    pot: 200,
    firstGameList: [
      {
        uid: 10004,
        userInfo: { uid: 10004, name: "legacy winner", userIcon: 90024 },
        pos: 4,
        posName: 99,
        score: 200,
        cards: [11, 12, 1, 2, 3, 4, 5],
        handPais: [11, 12],
        operateList: [{ operate: OP.ALL_IN, gameState: 4 }],
      },
      {
        uid: 10005,
        pos: 1,
        score: -100,
        cards: [21, 22, 1, 2, 3, 4, 5],
        handPais: [21, 22],
        operateList: [{ operate: OP.ABANDON, gameState: 4 }],
      },
      {
        uid: 10006,
        pos: 3,
        score: -100,
        cards: [-1, -1, 1, 2, 3, 4, 5],
        handPais: [-1, -1],
        commonPoker: [1, 2, 3, 4, 5],
      },
    ],
    secondGameList: [],
  });

  const rows = texasHistoryPayload(table, { roomId: table.roomId, beginNum: 0, endNum: 0 }).playBackList[0].firstGameList;
  assert.equal(rows[0].userName, "legacy winner");
  assert.equal(rows[0].userIcon, "/avator/90024.png");
  assert.equal(rows[0].posName, 5);
  assert.deepEqual(rows[0].showCards, [11, 12]);
  assert.equal(rows[0].cardTypePokers.length, 5);
  assert.deepEqual(rows[0].commonPoker, [1, 2, 3, 4, 5]);
  assert.deepEqual(rows[1].showCards, [-1, -1]);
  assert.deepEqual(rows[1].cardTypePokers, []);
  assert.deepEqual(rows[2].showCards, [-1, -1]);
  assert.deepEqual(rows[2].cardTypePokers, []);

  const detail = texasHistoryDetail(table, 1).exploitsInfoMsgs[0];
  const rounds = JSON.parse(detail.roundList);
  const inningResults = JSON.parse(detail.inningResults);
  assert.ok(rounds.some((round) => round.operationType === OP.SHOW && round.uid === 10004));
  assert.ok(!rounds.some((round) => round.operationType === OP.SHOW && round.uid === 10005));
  assert.ok(!rounds.some((round) => round.operationType === OP.SHOW && round.uid === 10006));
  assert.equal(inningResults[0].cardTypeInfo.handCardList.length, 5);
  assert.deepEqual(inningResults[0].handPais, [11, 12]);
  assert.deepEqual(inningResults[0].commonPokerList, [1, 2, 3, 4, 5]);
  assert.equal(inningResults[0].userIcon, "/avator/90024.png");
  assert.equal(inningResults[0].posName, 5);
  assert.deepEqual(inningResults[1].handPais, []);
  assert.equal(detail.memberResults[0].userInfo.icon, "/avator/90024.png");
  assert.equal(detail.memberResults[0].posName, 5);
});

test("dev holdem history paging follows the client's zero-based inning bounds", () => {
  const table = createTexasTable(700010, 19, { small_blind: 10, big_blind: 20 });
  table.currentInning = 100;
  table.history = Array.from({ length: 100 }, (_, index) => ({
    gameRoomId: table.roomId,
    currentInningNum: index + 1,
    firstGameList: [{
      uid: 1,
      operateList: index === 4 || index === 99
        ? [{ operate: OP.ALL_IN, operationType: OP.ALL_IN }]
        : [],
    }],
    secondGameList: [],
  }));

  const latest = texasHistoryPayload(table, { roomId: table.roomId, beginNum: -1, endNum: -1 });
  assert.equal(latest.totalNum, 100);
  assert.deepEqual(latest.playBackList.map((item) => item.currentInningNum),
    Array.from({ length: 20 }, (_, index) => index + 81));
  assert.equal(latest.playBackList.at(-1).currentInningNum, 100);

  const previousPage = texasHistoryPayload(table, { roomId: table.roomId, beginNum: 79, endNum: 79 });
  assert.equal(previousPage.totalNum, 100);
  assert.deepEqual(previousPage.playBackList.map((item) => item.currentInningNum), [80]);

  const firstPage = texasHistoryPayload(table, { roomId: table.roomId, beginNum: 0, endNum: 0 });
  assert.deepEqual(firstPage.playBackList.map((item) => item.currentInningNum), [1]);

  const highlights = texasHistoryPayload(table, {
    roomId: table.roomId,
    excellentGame: true,
    beginNum: 0,
    endNum: 0,
  });
  assert.deepEqual(highlights.playBackList.map((item) => item.currentInningNum), [5, 100]);
});

test("dev holdem keeps early hands available after more than 100 completed hands", () => {
  const table = createTexasTable(700013, 19, { small_blind: 10, big_blind: 20 });
  table.members.push(
    { uid: 31, name: "a", point: 100000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 32, name: "b", point: 100000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const io = mockIo();

  for (let inning = 0; inning < 101; inning += 1) {
    beginHand(io, table);
    const actor = table.members.find((player) => player.uid === table.hand.actorUid);
    onTexasAction(io, table, { userId: actor.uid }, {
      uid: actor.uid,
      operation: OP.ABANDON,
      operationData: 0,
    });
  }

  assert.equal(table.history.length, 101);
  const firstPage = texasHistoryPayload(table, { roomId: table.roomId, beginNum: 0, endNum: 0 });
  assert.equal(firstPage.totalNum, 101);
  assert.deepEqual(firstPage.playBackList.map((item) => item.currentInningNum), [1]);
});

test("dev holdem record detail matches the Holdem history detail parser", async () => {
  const { texasHistoryDetail } = await import("../../../../game-server/src/games/holdem/engine.js");
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({
    gameRoomId: 700000,
    currentInningNum: 4,
    smallBlind: 10,
    bigBlind: 20,
    initialBet: 20,
    firstGameList: [{
      uid: 10001,
      userName: "dev-10001",
      score: 50,
      openingPoint: 1000,
      cardTypeId: 2,
      cardTypeInfo: { cardTypeId: 2, handCardList: [1, 2, 3, 4, 5], pokerEnumList: [] },
      posName: 1,
      handPais: [1, 2],
      commonPoker: [3, 4, 5],
      showCards: true,
      operateList: [{ operationType: 7, bet: 10, totalBetScore: 50, pot: 100, gameState: 4, cards: [1, 2, 3, 4, 5] }],
    }],
    roundEvents: [
      { replayOrder: 2, uid: 10001, operationType: 7, bet: 10, currentBetScore: 10, totalBetScore: 50, pot: 100, gameState: 4, cards: [1, 2, 3, 4, 5] },
      { replayOrder: 1, uid: 0, operationType: 0, pot: 90, gameState: 5, board: [3, 4, 5] },
      { replayOrder: 0, uid: 10001, operationType: 1, bet: 40, currentBetScore: 40, totalBetScore: 40, pot: 40, gameState: 1, cards: [] },
    ],
  });
  const payload = texasHistoryDetail(table, 4);
  assert.equal(payload.exploitsInfoMsgs[0].gameInningId, "700000_4");
  const detail = payload.exploitsInfoMsgs[0];
  const inningResults = JSON.parse(detail.inningResults);
  const rounds = JSON.parse(detail.roundList);
  const inningInfo = JSON.parse(detail.inningInfo);
  assert.equal(inningResults[0].score, 50);
  assert.equal(inningResults[0].userName, "dev-10001");
  assert.match(inningResults[0].userIcon, /^\/avator\/\d+\.(?:png|jpe?g|webp)$/);
  assert.equal(inningResults[0].posName, 1);
  assert.equal(inningResults[0].isWin, true);
  assert.equal(inningResults[0].cardTypeInfo.cardTypeId, 2);
  assert.deepEqual(inningResults[0].cardTypeInfo.handCardList, [1, 2, 3, 4, 5]);
  assert.deepEqual(inningResults[0].handPais, [1, 2]);
  assert.deepEqual(inningResults[0].showCards, [1, 2]);
  assert.deepEqual(inningResults[0].cardTypePokers, [1, 2, 3, 4, 5]);
  assert.deepEqual(inningResults[0].commonPokerList, [3, 4, 5]);
  assert.deepEqual(inningResults[0].operateList.map((action) => action.gameState), [4, 3, 5]);
  assert.deepEqual(inningInfo, { forceShowCard: false });
  assert.deepEqual(rounds.map((round) => round.gameState), [1, 5, 4, 11]);
  assert.equal(rounds[1].pot, 90);
  assert.equal(rounds[2].roundBetScore, 10);
  assert.ok(rounds.some((round) => round.operationType === 11 && round.gameState === 11));
  assert.deepEqual(detail.memberResults[0].pais, [1, 2]);
  assert.equal(detail.memberResults[0].openingPoint, 1000);
  assert.equal(detail.memberResults[0].posName, 1);
  assert.equal(detail.memberResults[0].userInfo.name, "dev-10001");
  assert.equal(payload.exploitsInfoMsgs[0].memberResults[0].userInfo.uid, 10001);
  assert.equal(texasHistoryDetail(table, 5), null);
});

test("legacy holdem detail reconstructs public-card street rows", () => {
  const table = createTexasTable(700012, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({
    currentInningNum: 1,
    gameRoomId: table.roomId,
    pot: 100,
    firstGameList: [{
      uid: 21,
      userName: "legacy",
      score: 10,
      cardTypeId: 2,
      handPais: [1, 2],
      commonPoker: [3, 4, 5, 6, 7],
      showCards: true,
      operateList: [
        { operationType: OP.PASS, gameState: 6, bet: 0, currentBetScore: 0, totalBetScore: 20, pot: 80, cards: [1, 2, 3, 4, 5] },
        { operationType: OP.PASS, gameState: 8, bet: 0, currentBetScore: 0, totalBetScore: 20, pot: 90, cards: [1, 2, 3, 4, 5, 6] },
        { operationType: OP.PASS, gameState: 10, bet: 0, currentBetScore: 0, totalBetScore: 20, pot: 100, cards: [1, 2, 3, 4, 5, 6, 7] },
      ],
    }],
  });

  const detail = texasHistoryDetail(table, 1).exploitsInfoMsgs[0];
  const rounds = JSON.parse(detail.roundList);
  assert.deepEqual(rounds.map((round) => round.gameState), [5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(rounds.filter((round) => [5, 7, 9].includes(round.gameState)).map((round) => round.pot), [80, 90, 100]);
});

test("game back request returns room memory only in dev", async () => {
  const { HoldemGame } = await import("../../../../game-server/src/games/holdem/HoldemGame.js");
  const { SEND } = await import("../../../../game-server/src/messages.js");
  const game = new HoldemGame();
  const table = createTexasTable(700010, 19, { small_blind: 10, big_blind: 20 });
  table.history.push({ gameRoomId: table.roomId, currentInningNum: 1, firstGameList: [], secondGameList: [] });
  const replies = [];
  const ctx = { table, runtime: { env: "dev" }, send: (id, data) => replies.push({ id, data }) };
  assert.equal(game.onMessage(ctx, SEND.DZPK_SEND_GAME_BACK_REQ, { roomId: table.roomId }), true);
  assert.equal(replies[0].data.totalNum, 1);

  ctx.runtime.env = "prod";
  game.onMessage(ctx, SEND.DZPK_SEND_GAME_BACK_REQ, { roomId: table.roomId });
  assert.equal(replies[1].data.totalNum, 0);
});

test("ensureBots seats three to six bots and leaves a chair", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  ensureBots(table);
  const bots = table.members.filter((m) => m.bot);
  assert.ok(bots.length >= 3 && bots.length <= 6);
  assert.ok(table.members.length < 7);
  assert.equal(bots[0].userInfo, undefined);
  assert.equal(bots[0].uid, 90000001);
  assert.ok(Number.isFinite(bots[0].point));
});

test("observer-only holdem room runs autonomous bot hands without seating or charging the observer", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const { HoldemGame } = await import("../../../../game-server/src/games/holdem/HoldemGame.js");
  const game = new HoldemGame();
  const table = game.createTable(700001, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const session = { userId: 42, name: "watcher", wallet: 1234 };
  const messages = [];
  const io = {
    broadcast(msgid, payload) {
      messages.push({ msgid, payload, broadcast: true });
    },
    send(ws, msgid, payload) {
      messages.push({ ws, msgid, payload });
    },
    forEachPlayer(fn) {
      fn({ userId: session.userId, ws: "watcher" });
    },
  };
  const ctx = {
    table,
    session,
    body: { isOb: true },
    io,
    send(msgid, payload) {
      messages.push({ msgid, payload });
    },
  };

  game.onJoin(ctx);
  assert.equal(table.members.length, 0);
  table.cfg.robot_behavior = { checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000,
    carryMaxMs: 1000, joinProbability: 1, leaveProbability: 0 };
  game.tick(ctx);
  for (let i = 0; i < 3; i += 1) { now += 1000; game.tick(ctx); }
  assert.equal(table.observers.length, 1);
  assert.ok(table.members.length >= 3);
  assert.ok(table.members.every((member) => member.bot));
  assert.equal(session.wallet, 1234);
  assert.equal(table.phase, "starting");

  table.startAt = Date.now() - 1;
  game.tick(ctx);
  assert.equal(table.phase, "playing");
  assert.ok(table.members.some((member) => member.uid === table.hand.actorUid && member.bot));
  table.hand.botActAt = 0;
  game.tick(ctx);
  assert.ok(messages.some((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH));

  game.onLeave(ctx);
  assert.equal(table.observers.length, 0);
  assert.equal(table.phase, "playing");
  assert.notEqual(table.retireWhenHandEnds, true);
  assert.equal(table.expiresAt - table.createdAt, 8 * 60 * 60 * 1000);
  assert.notEqual(table.retired, true);
});

test("holdem schedules bot arrivals independently of explicit human sit", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const { HoldemGame } = await import("../../../../game-server/src/games/holdem/HoldemGame.js");
  const game = new HoldemGame();
  const table = game.createTable(700004, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const session = { userId: 45, name: "player", wallet: 1000 };
  const ctx = {
    table, session, body: { position: 0 }, io: { broadcast() {} }, send() {},
  };
  game.onJoin({ ...ctx, body: { isOb: true } });
  game.onSitDown(ctx);
  assert.equal(table.members.some((member) => member.bot), false);
  assert.ok(table.members.some((member) => !member.bot && member.point === 0));
  assert.equal(table.phase, "idle");
  table.cfg.robot_behavior = { checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000,
    carryMaxMs: 1000, joinProbability: 1, leaveProbability: 0 };
  game.tick(ctx);
  now += 1000;
  game.tick(ctx);
  assert.equal(table.members.filter((member) => member.bot).length, 1);
  for (let i = 0; i < 2; i += 1) { now += 1000; game.tick(ctx); }
  assert.equal(table.phase, "starting");
});

test("cash table bots still start when human has no funds to sit", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const { HoldemGame } = await import("../../../../game-server/src/games/holdem/HoldemGame.js");
  const game = new HoldemGame();
  const table = game.createTable(700002, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const session = { userId: 43, name: "poor player", wallet: 0 };
  const ctx = {
    table,
    session,
    body: {},
    io: { broadcast() {} },
    send() {},
  };

  game.onJoin(ctx);
  table.cfg.robot_behavior = { checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000,
    carryMaxMs: 1000, joinProbability: 1, leaveProbability: 0 };
  game.tick(ctx);
  for (let i = 0; i < 3; i += 1) { now += 1000; game.tick(ctx); }
  assert.ok(table.members.some((member) => member.bot));
  assert.equal(table.phase, "starting");
});

test("spectating a tournament table does not start a bot-only hand", async () => {
  const { HoldemGame } = await import("../../../../game-server/src/games/holdem/HoldemGame.js");
  const game = new HoldemGame();
  const table = game.createTable(700003, 101, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const ctx = {
    table,
    session: { userId: 44, name: "tournament watcher", wallet: 1234 },
    body: { isOb: true },
    io: { broadcast() {} },
    send() {},
  };

  game.onJoin(ctx);

  assert.equal(table.members.length, 0);
  assert.equal(table.phase, "idle");
});

test("operation choices are delivered only to the current seated player", () => {
  const table = createTexasTable(700004, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const targeted = [];
  const broadcasts = [];
  const io = {
    sendUser(uid, msgid, payload) {
      targeted.push({ uid, msgid, payload });
    },
    broadcast(msgid, payload) {
      broadcasts.push({ msgid, payload });
    },
    forEachPlayer() {},
  };

  beginHand(io, table);

  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].uid, table.hand.actorUid);
  assert.equal(targeted[0].msgid, PUSH.DZPK_OPERATION_PUSH);
  assert.equal(broadcasts.some((message) => message.msgid === PUSH.DZPK_OPERATION_PUSH), false);
  assert.ok(targeted[0].payload.some((option) => option.operation === OP.FOLLOW));
  assert.ok(targeted[0].payload.some((option) => option.operation === OP.ADD));
  const actor = table.members.find((member) => member.uid === table.hand.actorUid);
  const customBet = targeted[0].payload.find((option) => option.operation === OP.CUSTOM_ADD);
  assert.deepEqual(customBet.userData, {
    bigBlind: table.bigBlind,
    pot: table.hand.pot,
    followTotalBet: Math.max(0, table.hand.currentBet - actor.streetBet),
  });
  assert.equal(targeted[0].payload.some((option) => option.operation === OP.POT_1), false);
  assert.equal(targeted[0].payload.find((option) => option.operation === OP.FOLLOW).data, table.hand.currentBet - actor.streetBet);
  assert.equal(targeted[0].payload.find((option) => option.operation === OP.ADD).data, table.hand.currentBet + table.hand.minRaise);
  assert.ok(targeted[0].payload.every((option) => option.playerAmount === actor.point));
});

test("operation choices are dropped when IO cannot target a player", () => {
  const table = createTexasTable(700008, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const broadcasts = [];
  const io = {
    broadcast(msgid, payload) {
      broadcasts.push({ msgid, payload });
    },
    forEachPlayer() {},
  };

  beginHand(io, table);

  assert.equal(broadcasts.some((message) => message.msgid === PUSH.DZPK_OPERATION_PUSH), false);
});

test("check options expose protocol-sized BET data and a call pays only the amount owed", () => {
  const table = createTexasTable(700006, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const actor = { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, streetBet: 0, dealer: false, hole: [0, 1] };
  const other = { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, streetBet: 0, dealer: false, hole: [2, 3] };
  table.members.push(actor, other);
  table.phase = "playing";
  table.hand = { currentBet: 0, minRaise: 20, pot: 0, actorUid: actor.uid, street: "BET_FLOP", board: [0, 1, 2], deck: [4, 5], deckPos: 0, acted: new Set(), smallBlindId: actor.uid };
  const messages = [];
  const io = {
    sendUser(uid, msgid, payload) { messages.push({ uid, msgid, payload }); },
    broadcast(msgid, payload) { messages.push({ msgid, payload }); },
    forEachPlayer() {},
  };

  onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation: OP.PASS, operationData: 0 });
  const nextOptions = messages.find((message) => message.msgid === PUSH.DZPK_OPERATION_PUSH);
  assert.ok(nextOptions.payload.some((option) => option.operation === OP.BET));
  assert.equal(nextOptions.payload.find((option) => option.operation === OP.BET).data, table.bigBlind);
  assert.ok(nextOptions.payload.every((option) => option.playerAmount === actor.point));

  table.hand.actorUid = actor.uid;
  table.hand.currentBet = 20;
  actor.streetBet = 0;
  actor.point = 1000;
  onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation: OP.FOLLOW, operationData: 20 });
  assert.equal(actor.streetBet, 20);
  assert.equal(actor.totalBet, 20);
  assert.equal(actor.point, 980);
});

test("raise actionData is a displayed amount converted from major units to score units", () => {
  const table = createTexasTable(700007, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const actor = { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 20, streetBet: 20, dealer: false, hole: [0, 1] };
  const other = { uid: 2, name: "b", point: 980, pos: 1, state: 1, lastOperation: 0, totalBet: 20, streetBet: 20, dealer: true, hole: [2, 3] };
  table.members.push(actor, other);
  table.phase = "playing";
  table.hand = { currentBet: 20, minRaise: 20, pot: 40, actorUid: actor.uid, street: "BET_PERFLOP", board: [], deck: [4, 5], deckPos: 0, acted: new Set(), smallBlindId: actor.uid };
  const io = mockIo();

  onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation: OP.ADD, operationData: 1.15 });

  const result = io.messages.find((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH);
  assert.equal(actor.streetBet, 115);
  assert.equal(actor.point, 905);
  assert.equal(result.payload.currentBetScore, 95);
  assert.equal(result.payload.totalBetScore, 115);
  assert.equal(result.payload.operation, OP.ADD);
  assert.equal(table.hand.replayActions[0].operationType, OP.ADD);
  assert.equal(result.payload.pot, 135);
});

test("custom pot shortcut action applies its displayed raise amount", () => {
  const table = createTexasTable(700009, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const actor = { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 20, streetBet: 20, dealer: false, hole: [0, 1] };
  const other = { uid: 2, name: "b", point: 980, pos: 1, state: 1, lastOperation: 0, totalBet: 20, streetBet: 20, dealer: true, hole: [2, 3] };
  table.members.push(actor, other);
  table.phase = "playing";
  table.hand = { currentBet: 20, minRaise: 20, pot: 40, actorUid: actor.uid, street: "BET_PERFLOP", board: [], deck: [4, 5], deckPos: 0, acted: new Set(), smallBlindId: actor.uid };
  const io = mockIo();

  onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation: OP.POT_1, operationData: 0.2 });

  assert.equal(actor.streetBet, 40);
  assert.equal(actor.point, 980);
  assert.equal(table.hand.currentBet, 40);
  assert.equal(table.hand.replayActions[0].operationType, OP.POT_1);
});

test("GTO_REQ replies with operation weights", () => {
  const sent = [];
  onGtoReq((msgid, payload) => sent.push({ msgid, payload }), {
    tipsListStr: '[{"operation":6,"data":0},{"operation":9,"data":0}]',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgid, PUSH.GTO_RES);
  assert.equal(sent[0].payload["6"], 0.5);
  assert.equal(sent[0].payload["9"], 0.5);
});
