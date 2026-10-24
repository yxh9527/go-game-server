import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./create-handler.js";
import { createTexasTable } from "./games/holdem/engine.js";
import { createRegistry } from "./registry.js";
import { decodeFrame, encodeFrame } from "./codec.js";
import { PUSH, SEND } from "./messages.js";

test("hundred unsubscribe requires login and works after leaving a room without creating one", async () => {
  const registry = createRegistry();
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  const handler = await createHandler({ hotVersion: "unregister", registry, configs: [], findConfig: () => null,
    wallet: { credit() { assert.fail("unsubscribe is not a cash-out"); }, persist() { assert.fail("unsubscribe is not a wallet mutation"); } },
    log: { info() {}, error() {} },
  });
  await handler.onMessage(ws, encodeFrame(SEND.MB_UNREG_ROOMS_REQ));
  assert.equal(received.length, 0);
  registry.bind(ws, { userId: 64, roomId: 700017, inRoom: false, authenticated: false });
  await handler.onMessage(ws, encodeFrame(SEND.MB_UNREG_ROOMS_REQ));
  assert.equal(received.length, 0);
  registry.session(ws).authenticated = true;
  await handler.onMessage(ws, encodeFrame(SEND.MB_UNREG_ROOMS_REQ));
  assert.deepEqual(received.map((frame) => [frame.msgid, frame.payload]), [[PUSH.MB_UNREG_ROOMS_RES, {}]]);
  assert.equal(registry.tables.size, 0);
  assert.equal(registry.session(ws).inRoom, false);
});

for (const roomType of [19, 25]) {
  for (const state of ["observer", "pending-carry", "funded", "stood-up"]) {
    test("room exit acknowledges the requesting socket: " + roomType + " / " + state, async () => {
      const registry = createRegistry();
      const received = [];
      const peerReceived = [];
      const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
      const peer = { readyState: 1, send(frame) { peerReceived.push(decodeFrame(frame)); } };
      const credits = [];
      const runtime = {
        hotVersion: "exit-test", registry, configs: [], findConfig: () => null,
        gateway: { async getLoginData(userId) { return { userId, agentId: 1, userName: "player" }; } },
        wallet: {
          async load(session) { session.wallet = 1000; },
          async persist() {},
          debit(session, amount) {
            if (session.wallet < amount) return { ok: false };
            session.wallet -= amount;
            return { ok: true };
          },
          credit(session, amount) {
            credits.push(amount);
            session.wallet += amount;
            return { ok: true };
          },
        },
        log: { info() {}, error() {} },
      };
      const handler = await createHandler(runtime);
      for (const [socket, uid] of [[ws, 58], [peer, 59]]) {
        await handler.onMessage(socket, encodeFrame(SEND.ROOM_LOGIN, { userId: uid, roomId: 700013 }));
        await handler.onMessage(socket, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: 700013, roomType }));
      }
      const session = registry.session(ws);
      const table = registry.getTable(700013, 1, session.gameId);
      const createdAt = table.createdAt;
      if (state !== "observer") await handler.onMessage(ws, encodeFrame(SEND.SEND_SITDOWN, { position: 0 }));
      if (["funded", "stood-up"].includes(state)) {
        await handler.onMessage(ws, encodeFrame(SEND.SEND_CARRY_SCORE, { carryIn: 5 }));
      }
      if (state === "stood-up") await handler.onMessage(ws, encodeFrame(SEND.SEND_STANDUP));
      received.length = 0;
      peerReceived.length = 0;
      credits.length = 0;

      await handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));

      const expected = { roomId: table.roomId, uid: 58, type: 1 };
      assert.deepEqual(received.filter((frame) => frame.msgid === PUSH.USER_LEVEL_ROOM).map((frame) => frame.payload), [expected]);
      assert.deepEqual(peerReceived.filter((frame) => frame.msgid === PUSH.USER_LEVEL_ROOM).map((frame) => frame.payload), [expected]);
      assert.equal(received.at(-1).msgid, PUSH.USER_LEVEL_ROOM, "exit acknowledgment follows balance persistence and all cleanup");
      assert.equal(received.some((frame) => frame.msgid === PUSH.ROOM_INFO), false);
      assert.equal(session.inRoom, false);
      assert.equal(session.wallet, 1000);
      assert.equal(table.members.some((member) => member.uid === 58), false);
      assert.equal(table.observers.some((member) => member.uid === 58), false);
      assert.equal(registry.getTable(table.roomId, 1, session.gameId), table);
      assert.equal(table.createdAt, createdAt, "leaving does not recycle/reset the eight-hour room");
      const rank = peerReceived.find((frame) => frame.msgid === PUSH.DZPK_PUSH_RANKINGLIST).payload;
      assert.equal(rank.obMemberList.some((member) => member.uid === 58), false);
      if (["funded", "stood-up"].includes(state)) {
        const row = rank.userList.find((member) => member.uid === 58);
        assert.equal(row.onTableFlag, 0);
        assert.equal(row.totalPoint, 500);
        assert.equal(row.carryOutPoint, 500);
      }
      const creditCount = credits.length;
      received.length = 0;
      peerReceived.length = 0;
      await handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
      assert.deepEqual(received.filter((frame) => frame.msgid === PUSH.USER_LEVEL_ROOM).map((frame) => frame.payload), [expected]);
      assert.equal(credits.length, creditCount, "repeated exits must not refund twice");
      assert.equal(peerReceived.length, 0);
      await handler.onMessage(ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType }));
      assert.equal(session.inRoom, true);
      assert.equal(table.members.some((member) => member.uid === 58), false);
      assert.equal(table.observers.filter((member) => member.uid === 58).length, 1);
      assert.equal(table.createdAt, createdAt);
      await handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
      const creditsAfterReentry = credits.length;
      await handler.onClose(ws);
      assert.equal(registry.session(ws), null);
      assert.equal(credits.length, creditsAfterReentry, "socket close after exit must not refund twice");
    });
  }
}

test("concurrent exits share cash-out across hot reload and wait before acknowledging", async () => {
  const registry = createRegistry();
  const table = createTexasTable(700014, 19, { carry_min: 500 });
  table.members.push({ uid: 60, pos: 0, point: 500, name: "player", state: 1 });
  registry.setTable(table.roomId, table);
  const session = { userId: 60, roomId: table.roomId, gameId: table.gameId, inRoom: true, wallet: 500 };
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  registry.bind(ws, session);
  let beginCredit, finishCredit;
  const creditStarted = new Promise((resolve) => { beginCredit = resolve; });
  const creditWait = new Promise((resolve) => { finishCredit = resolve; });
  let credits = 0;
  const runtime = { hotVersion: "exit-concurrent-before", registry, configs: [], findConfig: () => null,
    wallet: { async credit(player, amount) {
      credits += 1;
      beginCredit();
      await creditWait;
      player.wallet += amount;
      return { ok: true };
    }, async persist() {} }, log: { info() {}, error() {} },
  };
  const handler = await createHandler(runtime);
  const first = handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
  const duplicate = handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
  await creditStarted;
  runtime.hotVersion = "exit-concurrent-after";
  const reloaded = await createHandler(runtime);
  const afterReload = reloaded.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
  assert.equal(received.some((frame) => frame.msgid === PUSH.USER_LEVEL_ROOM), false);
  finishCredit();
  await Promise.all([first, duplicate, afterReload]);
  assert.equal(credits, 1);
  assert.equal(session.wallet, 1000);
  assert.equal(received.filter((frame) => frame.msgid === PUSH.USER_LEVEL_ROOM).length, 1);
  await reloaded.onClose(ws);
  assert.equal(credits, 1);
});

test("retry recovers a previously completed exit that never received its client acknowledgment", async () => {
  const registry = createRegistry();
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  registry.bind(ws, { userId: 61, roomId: 700015, gameId: "holdem", inRoom: false, wallet: 1000 });
  const handler = await createHandler({ hotVersion: "exit-recover", registry, configs: [], findConfig: () => null,
    wallet: { credit() { assert.fail("completed exit must not refund again"); }, async persist() {} },
    log: { info() {}, error() {} },
  });
  await handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
  assert.deepEqual(received.map((frame) => [frame.msgid, frame.payload]), [
    [PUSH.USER_LEVEL_ROOM, { roomId: 700015, uid: 61, type: 1 }],
  ]);
  assert.equal(registry.tables.size, 0, "a retry cannot recreate the old room");
});

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
