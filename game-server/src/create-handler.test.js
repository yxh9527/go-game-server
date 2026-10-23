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
  assert.ok(table.members.some((member) => member.bot));
  assert.ok(received.some((frame) => frame.msgid === PUSH.CARRYIN_RESULT));
  assert.ok(received.some((frame) => frame.msgid === PUSH.JOIN_ROOM));
});

test("joining a holdem room keeps the real player spectating while bots play", async () => {
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
  assert.ok(table.members.some((member) => member.bot));
  assert.equal(received.some((frame) => frame.msgid === PUSH.JOIN_ROOM || frame.msgid === PUSH.CARRYIN_RESULT), false);
});
