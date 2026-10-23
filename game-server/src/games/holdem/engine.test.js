import assert from "node:assert/strict";
import test from "node:test";
import { beginHand, botChoose, createTexasTable, ensureBot, ensureBots, onGtoReq, onTexasAction, texasConf, texasRoomInfo, tickTexas } from "./engine.js";
import { OP } from "./op.js";
import { PUSH } from "../../messages.js";

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
  assert.ok(io.messages.some((m) => m.msgid === 3432));
});

test("initial bets are collected before blinds and remain separate from the call amount", () => {
  const table = createTexasTable(700009, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const io = mockIo();

  beginHand(io, table);

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

test("observer-only holdem room starts bots without seating or charging the observer", async () => {
  const { HoldemGame } = await import("./HoldemGame.js");
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

  assert.equal(table.observers.length, 1);
  assert.equal(table.members.length >= 3, true);
  assert.ok(table.members.every((member) => member.bot));
  assert.equal(session.wallet, 1234);
  assert.equal(table.phase, "starting");

  table.startAt = Date.now() - 1;
  game.tick(ctx);
  assert.equal(table.phase, "playing");
  assert.equal(table.currentInning, 1);
  assert.ok(table.members.some((member) => member.uid === table.hand.actorUid && member.bot));

  table.hand.botActAt = 0;
  game.tick(ctx);
  assert.ok(messages.some((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH));

  game.onLeave(ctx);
  assert.equal(table.observers.length, 0);
  assert.equal(table.members.length, 0);
  assert.equal(table.phase, "idle");
  assert.equal(table.hand, null);
});

test("holdem bots wait when a failed player join leaves no observer", async () => {
  const { HoldemGame } = await import("./HoldemGame.js");
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

  assert.ok(table.members.some((member) => member.bot));
  assert.equal(table.phase, "idle");
});

test("spectating a tournament table does not start a bot-only hand", async () => {
  const { HoldemGame } = await import("./HoldemGame.js");
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

  assert.ok(table.members.every((member) => member.bot));
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
  assert.equal(targeted[0].payload.some((option) => option.operation === OP.POT_1), false);
  const actor = table.members.find((member) => member.uid === table.hand.actorUid);
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
  assert.equal(result.payload.pot, 135);
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
