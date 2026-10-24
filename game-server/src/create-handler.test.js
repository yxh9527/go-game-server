import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./create-handler.js";
import { createTexasTable } from "./games/holdem/engine.js";
import { createRegistry } from "./registry.js";
import { decodeFrame, encodeFrame } from "./codec.js";
import { PUSH, SEND } from "./messages.js";

test("private holdem operation options only reach a seated player", async () => {
  const registry = createRegistry();
  const table = createTexasTable(700009, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "player-one", point: 1000, pos: 0, state: 1, totalBet: 0, streetBet: 0 },
    { uid: 2, name: "player-two", point: 1000, pos: 1, state: 1, totalBet: 0, streetBet: 0 },
  );
  table.phase = "starting";
  table.startAt = 0;
  registry.setTable(table.roomId, table);

  const received = new Map();
  for (const session of [
    { userId: 1, roomId: table.roomId },
    { userId: 2, roomId: table.roomId },
    { userId: 99, roomId: table.roomId },
  ]) {
    const ws = {
      readyState: 1,
      send(frame) {
        received.get(session.userId).push(decodeFrame(frame));
      },
    };
    received.set(session.userId, []);
    registry.bind(ws, session);
  }

  const handler = await createHandler({
    hotVersion: Date.now(),
    registry,
    configs: [],
    findConfig: () => null,
    wallet: { persist: async () => {} },
    log: { info() {}, error() {} },
  });

  handler.tick();

  const actorId = table.hand.actorUid;
  assert.ok(received.get(actorId).some((frame) => frame.msgid === PUSH.DZPK_OPERATION_PUSH));
  assert.equal(received.get(99).some((frame) => frame.msgid === PUSH.DZPK_OPERATION_PUSH), false);
  assert.ok(received.get(99).some((frame) => frame.msgid === PUSH.DZPK_OPERATION_PLAYER_PUSH));
});

test("client sit-down request is routed and triggers the holdem carry-in flow", async () => {
  const registry = createRegistry();
  const received = [];
  const ws = {
    readyState: 1,
    send(frame) { received.push(decodeFrame(frame)); },
  };
  const handler = await createHandler({
    hotVersion: Date.now(),
    registry,
    configs: [],
    findConfig: () => null,
    gateway: { async getLoginData(userId) { return { userId, agentId: 1, userName: "player" }; } },
    wallet: {
      async load(session) { session.wallet = 1000; },
      async persist() {},
    },
    log: { info() {}, error() {} },
  });

  await handler.onMessage(ws, encodeFrame(SEND.ROOM_LOGIN, { userId: 55, roomId: 700010 }));
  await handler.onMessage(ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: 700010, roomType: 19 }));
  await handler.onMessage(ws, encodeFrame(SEND.SEND_SITDOWN, { position: 0 }));

  const table = registry.getTable(700010, 1, "holdem");
  assert.ok(table.members.some((member) => member.uid === 55 && member.point === 0));
  assert.equal(table.members.some((member) => member.bot), false, "human seating does not synchronously fill bots");
  assert.ok(received.some((frame) => frame.msgid === PUSH.CARRYIN_RESULT));
  assert.ok(received.some((frame) => frame.msgid === PUSH.JOIN_ROOM));
});

test("joining a holdem room keeps the real player spectating while bots play", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const registry = createRegistry();
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  const handler = await createHandler({
    hotVersion: Date.now(),
    registry,
    configs: [],
    findConfig: () => null,
    gateway: { async getLoginData(userId) { return { userId, agentId: 1, userName: "watcher" }; } },
    wallet: { async load(session) { session.wallet = 1000; }, async persist() {} },
    log: { info() {}, error() {} },
  });

  await handler.onMessage(ws, encodeFrame(SEND.ROOM_LOGIN, { userId: 56, roomId: 700011 }));
  await handler.onMessage(ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: 700011, roomType: 19 }));

  const table = registry.getTable(700011, 1, "holdem");
  assert.ok(table.observers.some((observer) => observer.uid === 56));
  assert.equal(table.members.some((member) => member.uid === 56), false);
  assert.equal(table.members.length, 0);
  assert.equal(received.some((frame) => frame.msgid === PUSH.JOIN_ROOM || frame.msgid === PUSH.CARRYIN_RESULT), false);
  table.cfg.robot_behavior = { checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000,
    carryMaxMs: 1000, joinProbability: 1, leaveProbability: 0 };
  await handler.tick();
  for (let i = 0; i < 6; i += 1) { now += 1000; await handler.tick(); }
  assert.equal(table.phase, "playing");
  assert.equal(table.members.some((member) => member.uid === 56), false);
  assert.equal(registry.session(ws).wallet, 1000);
  assert.ok(received.some((frame) => frame.msgid === PUSH.JOIN_ROOM && frame.payload.userInfo.uid !== 56));
  assert.equal(received.some((frame) => frame.msgid === PUSH.CARRYIN_RESULT), false);
  const rank = received.filter((frame) => frame.msgid === PUSH.DZPK_PUSH_RANKINGLIST).at(-1).payload;
  assert.ok(Number.isFinite(rank.lastTime));
  assert.equal(rank.userList.length, table.members.length);
  assert.equal(rank.obMemberList[0].uid, 56);
  assert.equal(received.find((frame) => [PUSH.DZPK_PUSH_RANKINGLIST, PUSH.DZPK_PUSH_WATCHGAME].includes(frame.msgid)).msgid,
    PUSH.DZPK_PUSH_RANKINGLIST);
  received.length = 0;
  await handler.onMessage(ws, encodeFrame(SEND.DATA_REPORT, { buttonCode: "realtime_rank_main_btn" }));
  assert.equal(received[0].msgid, PUSH.DZPK_PUSH_RANKINGLIST);
  assert.equal(received[1].msgid, PUSH.DZPK_PUSH_WATCHGAME);
});

test("wire sit-down survives hot reload then times out to observer without changing the wallet", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const registry = createRegistry();
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  const runtime = {
    hotVersion: "carry-before", registry, configs: [], findConfig: () => null,
    gateway: { async getLoginData(userId) { return { userId, agentId: 1, userName: "waiting" }; } },
    wallet: {
      async load(session) { session.wallet = 1000; }, async persist() {},
      debit() { assert.fail("expired carry-in must not debit"); },
      credit() { assert.fail("unfunded timeout must not credit"); },
    },
    log: { info() {}, error() {} },
  };
  let handler = await createHandler(runtime);
  await handler.onMessage(ws, encodeFrame(SEND.ROOM_LOGIN, { userId: 57, roomId: 700012 }));
  await handler.onMessage(ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: 700012, roomType: 19 }));
  const table = registry.getTable(700012, 1, "holdem");
  table.startAt = now + 60000;
  await handler.onMessage(ws, encodeFrame(SEND.SEND_SITDOWN, { position: 0 }));
  const seat = table.members.find((member) => member.uid === 57);
  assert.equal(seat.carryDeadline, now + 12000);
  assert.equal(received.filter((frame) => frame.msgid === PUSH.CARRYIN_RESULT).at(-1).payload.leftTime, 12000);
  now += 5000;
  runtime.hotVersion = "carry-after";
  handler = await createHandler(runtime);
  await handler.onMessage(ws, encodeFrame(SEND.LOGIN_ROOM, {}));
  const snapshot = received.filter((frame) => frame.msgid === PUSH.ROOM_INFO).at(-1).payload;
  assert.equal(snapshot.memberList.find((member) => member.userInfo?.uid === 57).carryLeftTime, 7000);
  assert.equal(table.members.find((member) => member.uid === 57), seat);
  received.length = 0;
  now += 7000;
  await handler.tick();
  assert.equal(registry.session(ws).inRoom, true);
  assert.equal(registry.session(ws).wallet, 1000);
  assert.ok(table.observers.some((member) => member.uid === 57 && member.point === 1000));
  assert.equal(table.members.some((member) => member.uid === 57), false);
  assert.equal(received.find((frame) => frame.msgid === PUSH.USER_STANDUP_ROOM).payload, 57);
  assert.equal(received.some((frame) => [PUSH.ROOM_DISSMISS, PUSH.USER_LEVEL_ROOM].includes(frame.msgid)), false);
  received.length = 0;
  await handler.onMessage(ws, encodeFrame(SEND.SEND_CARRY_SCORE, { carryIn: 5 }));
  assert.equal(received.find((frame) => frame.msgid === PUSH.CARRY_SCORE_RESULT).payload.state, 1);
  assert.equal(registry.session(ws).wallet, 1000);
  assert.equal(table.members.some((member) => member.uid === 57), false);
});
