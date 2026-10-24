import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../../game-server/src/create-handler.js";
import { createRegistry } from "../../game-server/src/registry.js";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { SEND } from "../../game-server/src/messages.js";
import { SeatGame } from "../../game-server/src/core/SeatGame.js";
import { HoldemGame } from "../../game-server/src/games/holdem/HoldemGame.js";
import { ZjhGame } from "../../game-server/src/games/zjh/ZjhGame.js";
import { OP } from "../../game-server/src/games/holdem/op.js";
import { ZJH_OP, ZJH_SEND } from "../../game-server/src/games/zjh/messages.js";
import { finishHandStats } from "../../game-server/src/core/room-features.js";
import * as lifecycle from "../../game-server/src/core/room-lifecycle.js";

async function fixture(t, type = 19) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const registry = createRegistry();
  const game = type === 25 ? new ZjhGame() : new HoldemGame();
  const table = game.createTable(700000, type, { game_room_config_id: 70, carry_min: 100,
    robot_behavior: { joinProbability: 0, leaveProbability: 0 } });
  registry.setTable(table.roomId, table, 1, game.id);
  const runtime = { env: "dev", hotVersion: "suspension-test", registry, configs: [], findConfig: () => null,
    log: { info() {}, error: (...args) => assert.fail(JSON.stringify(args)) },
    wallet: { async load(session) { session.wallet = 500; },
      debit(session, amount) {
        if (session.wallet < amount) return { ok: false };
        session.wallet -= amount;
        return { ok: true };
      },
      credit(session, amount) { session.wallet += amount; return { ok: true }; }, async persist() {} },
  };
  const handler = await createHandler(runtime);
  const received = [];
  const ws = { readyState: 1, send: (raw) => received.push(decodeFrame(raw)) };
  const session = { userId: 42, roomId: table.roomId, gameId: game.id, agentId: 1,
    inRoom: false, authenticated: true, wallet: 500 };
  registry.bind(ws, session);
  const ctx = { table, session, runtime, send() {},
    io: { env: "dev", broadcast() {}, send() {}, forEachPlayer() {} } };
  const join = (current = handler) => current.onMessage(ws,
    encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType: type }));
  const leave = () => handler.onMessage(ws, encodeFrame(SEND.SEND_LEVEL_OUT));
  const bots = () => {
    table.members = [1, 2].map((n) => ({ uid: 90000000 + n, name: "Bot" + n,
      pos: n - 1, bot: true, point: 2000, totalBet: 0, streetBet: 0 }));
  };
  return { table, game, registry, runtime, handler, ctx, session, ws, received, join, leave, bots,
    now: () => now, advance: (ms) => { now += ms; } };
}

async function finishCurrentHand(f) {
  assert.equal(f.table.phase, "playing");
  for (let n = 0; f.table.hand && n < 20; n++) {
    f.game.onMessage({ ...f.ctx, session: { userId: f.table.hand.actorUid } },
      f.table.roomType === 19 ? SEND.DZPK_SEND_ACTION : ZJH_SEND.ACTION,
      { operation: f.table.roomType === 19 ? OP.ABANDON : ZJH_OP.FOLD, operationData: 0 });
  }
  assert.equal(f.table.hand, null);
  await f.game.afterRound(f.ctx);
}

async function startNextHand(f, handler = f.handler) {
  f.advance(Math.max(0, f.table.startAt - f.now()) + 1000);
  await handler.tick();
  if (f.table.phase === "starting") {
    f.advance(Math.max(0, f.table.startAt - f.now()) + 1);
    await handler.tick();
  }
  assert.equal(f.table.phase, "playing");
}

for (const type of [19, 25]) {
  test(type + ": no humans suspends dealing and robot traffic, even with funded bots", async (t) => {
    const f = await fixture(t, type);
    f.bots();
    f.table.cfg.robot_behavior.joinProbability = 1;
    const before = structuredClone(f.table.members);
    for (let i = 0; i < 20; i++) { f.advance(1000); await f.handler.tick(); }
    assert.deepEqual(f.table.members, before);
    assert.equal(f.table.currentInning, 0);
    assert.equal(f.table.robotTraffic, undefined);
    assert.equal(f.table.suspendedAt, f.table.createdAt);
    assert.equal(f.registry.getTable(f.table.roomId, 1, f.game.id), f.table);
    await f.join();
    assert.equal(f.table.suspendedAt, undefined);
    assert.equal(f.table.observers[0].uid, 42, "joining wakes as a spectator");
    await f.handler.tick();
    f.advance(5000);
    await f.handler.tick();
    assert.equal(f.table.phase, "playing");
    assert.ok(f.table.members.every((member) => member.bot));
  });

  test(type + ": exactly three real settlements after departure suspend before a fourth deal, across hot reload", async (t) => {
    const f = await fixture(t, type);
    f.bots();
    await f.join();
    f.game.startRound(f.ctx);
    await f.handler.tick(); // Adopt bot accounts and initialize shared traffic.
    const roomStats = f.table.roomFeatures;
    const traffic = f.table.robotTraffic;
    const profile = [...traffic.profiles.values()][0];
    const createdAt = f.table.createdAt;
    const expiry = f.table.expiresAt;
    await f.leave();
    assert.equal(f.table.emptySinceHands, 0);
    assert.equal(f.table.suspendedAt, undefined);
    await finishCurrentHand(f);
    assert.equal(f.table.roomFeatures.totalHands, 1);
    assert.equal(f.table.suspendedAt, undefined);
    for (let i = 0; i < 10; i++) await f.handler.tick();
    assert.equal(f.table.emptySinceHands, 0, "repeated ticks cannot reset the baseline");
    const next = await createHandler({ ...f.runtime, hotVersion: "suspension-reload-" + type });
    await startNextHand(f, next);
    await finishCurrentHand(f);
    assert.equal(f.table.roomFeatures.totalHands, 2);
    assert.equal(f.table.suspendedAt, undefined);
    finishHandStats(f.table, []);
    assert.equal(f.table.roomFeatures.totalHands, 2, "duplicate settlement cannot count as the third hand");
    await startNextHand(f, next);
    await finishCurrentHand(f);
    assert.equal(f.table.roomFeatures.totalHands, 3);
    const paused = f.table.suspendedAt;
    assert.equal(paused, f.now());
    const timerBefore = [f.table.startAt, traffic.nextCheckAt, profile.seatedAt,
      profile.waitingAt, profile.canSitAt];
    const balances = f.table.members.map((member) => member.point);
    f.advance(60 * 60 * 1000);
    const sleepingReload = await createHandler({ ...f.runtime, hotVersion: "sleeping-reload-" + type });
    for (let i = 0; i < 10; i++) await sleepingReload.tick();
    assert.equal(f.table.suspendedAt, paused);
    assert.equal(f.table.hand, null);
    assert.deepEqual(f.table.members.map((member) => member.point), balances);
    assert.equal(f.table.currentInning, 3);
    assert.equal(f.table.roomFeatures, roomStats);
    assert.equal(f.table.robotTraffic, traffic);
    await f.join(sleepingReload);
    const slept = f.now() - paused;
    assert.deepEqual([f.table.startAt, traffic.nextCheckAt, profile.seatedAt,
      profile.waitingAt, profile.canSitAt], timerBefore.map((value) => value + slept));
    assert.equal(f.table.emptySinceHands, undefined);
    assert.equal(f.table.suspendedAt, undefined);
    assert.equal(f.table.createdAt, createdAt);
    assert.equal(f.table.expiresAt, expiry);
    assert.equal(f.game.roomInfo(f.table).leftTime, Math.ceil((expiry - f.now()) / 1000));
    await f.join(sleepingReload);
    assert.equal(f.table.startAt, timerBefore[0] + slept, "duplicate join cannot extend the delay");
    await startNextHand(f, sleepingReload);
    assert.equal(f.table.currentInning, 4);
  });

  test(type + ": eight-hour expiry overrides the three-hand allowance and finishes only the current hand", async (t) => {
    const f = await fixture(t, type);
    f.bots();
    await f.join();
    f.game.startRound(f.ctx);
    const stats = f.table.roomFeatures;
    await f.leave();
    const inning = f.table.currentInning;
    f.advance(lifecycle.ROOM_LIFETIME_MS);
    assert.equal(f.table.currentInning, inning);
    assert.equal(f.table.roomFeatures.totalHands, 0);
    for (let i = 0; i < 300 && f.registry.tables.size; i++) {
      await f.handler.tick();
      f.advance(1000);
    }
    assert.equal(f.registry.tables.size, 0);
    assert.equal(f.table.currentInning, inning);
    assert.equal(stats.totalHands, 1, "the real hand settles before cleanup");
    assert.equal(f.table.hand, null);
    assert.equal(f.table.robotTraffic, undefined);
    assert.equal(f.session.wallet, 500, "robot payouts never credit a human wallet");
  });

  test(type + ": a real observer returning after two hands cancels and restarts the allowance on leaving", async (t) => {
    const f = await fixture(t, type);
    f.bots();
    await f.join();
    f.game.startRound(f.ctx);
    await f.leave();
    await finishCurrentHand(f);
    await startNextHand(f);
    await finishCurrentHand(f);
    await startNextHand(f);
    const hand = f.table.hand;
    const deadline = hand.deadline;
    await f.join();
    assert.equal(f.table.emptySinceHands, undefined);
    assert.equal(f.table.hand, hand);
    assert.equal(hand.deadline, deadline, "no pause occurred during the empty allowance");
    await finishCurrentHand(f);
    assert.equal(f.table.roomFeatures.totalHands, 3);
    assert.equal(f.table.suspendedAt, undefined);
    await f.leave();
    assert.equal(f.table.emptySinceHands, 3);
    for (let i = 0; i < 3; i++) {
      await startNextHand(f);
      await finishCurrentHand(f);
      assert.equal(Number.isFinite(f.table.suspendedAt), i === 2);
    }
    assert.equal(f.table.roomFeatures.totalHands, 6);
  });

  test(type + ": the last seated human's leaving fold counts its settlement as hand one", async (t) => {
    const f = await fixture(t, type);
    f.bots();
    f.table.members = f.table.members.slice(0, 1);
    await f.join();
    f.game.sit(f.table, f.session, f.ctx, { pos: 1, buyIn: 200 });
    f.game.startRound(f.ctx);
    await f.leave();
    assert.equal(f.table.hand, null);
    assert.equal(f.table.roomFeatures.totalHands, 1);
    assert.equal(f.table.emptySinceHands, 0);
    assert.equal(f.table.suspendedAt, undefined);
    await f.leave();
    assert.equal(f.table.emptySinceHands, 0, "duplicate leave must not reset the allowance");
  });
}

test("an untouched sleeping room is reclaimed at its original eight-hour deadline", async (t) => {
  const f = await fixture(t);
  f.advance(lifecycle.ROOM_LIFETIME_MS - 1);
  await f.handler.tick();
  assert.equal(f.registry.tables.size, 1);
  f.advance(1);
  await f.handler.tick();
  assert.equal(f.registry.tables.size, 0);
  assert.equal(f.table.currentInning, 0);
});

test("a new SeatGame inherits the three-hand allowance and counts real seats and observers", () => {
  const game = new SeatGame({ id: "new-game", kind: "normal", roomTypes: [987], minPeople: 2 });
  const table = game.createTable(9870000, 987, {});
  const createdAt = table.createdAt;
  assert.equal(lifecycle.syncActivity(table), false);
  table.members.push({ uid: 1, bot: false, point: 0 });
  assert.equal(lifecycle.syncActivity(table), true, "unfunded human seats count as presence");
  game.watch(table, { userId: 2, wallet: 0 });
  const ctx = { table, session: { userId: 1 }, io: { broadcast() {} } };
  game.onLeave(ctx);
  assert.equal(table.suspendedAt, undefined, "another real observer keeps the table awake");
  table.observers.push({ uid: 9, bot: true });
  game.onLeave({ ...ctx, session: { userId: 2 } });
  assert.equal(table.suspendedAt, undefined, "last human departure begins a three-hand allowance");
  assert.equal(table.emptySinceHands, 0);
  table.roomFeatures.totalHands = 2;
  assert.equal(lifecycle.syncActivity(table), true);
  table.roomFeatures.totalHands = 3;
  assert.equal(lifecycle.syncActivity(table), false, "bot observers cannot cancel the allowance");
  assert.equal(table.createdAt, createdAt);
});

test("sleep shifts bot carry/cooldown and next-hand timing without changing human carry deadlines", () => {
  const table = { kind: "normal", roomType: 19, members: [{ bot: true, carryDeadline: 12000 }],
    humanPresenceSeen: true, emptySinceHands: 0, roomFeatures: { totalHands: 3 },
    observers: [], startAt: 4000, robotTraffic: { nextCheckAt: 5000,
      profiles: new Map([[9, { carryAt: 2000, seatedAt: 1000, waitingAt: 1000, canSitAt: 4000 }]]) } };
  assert.equal(lifecycle.syncActivity(table, 1000), false);
  table.members.push({ uid: 42, bot: false, carryDeadline: 113000 });
  assert.equal(lifecycle.syncActivity(table, 101000), true);
  assert.equal(table.startAt, 104000);
  assert.equal(table.robotTraffic.nextCheckAt, 105000);
  assert.equal(table.robotTraffic.profiles.get(9).carryAt, 102000);
  assert.equal(table.members[0].carryDeadline, 112000);
  assert.equal(table.members[1].carryDeadline, 113000);
});

test("hot adoption resumes an old immediately-suspended active room for three real settlements", async () => {
  const table = { kind: "normal", roomType: 19, createdAt: 1000, expiresAt: 1000 + lifecycle.ROOM_LIFETIME_MS,
    members: [{ bot: true }], observers: [], currentInning: 8, roomFeatures: { totalHands: 7 },
    phase: "playing", hand: { deadline: 4000, botActAt: 2000 }, suspendedAt: 1000 };
  const reloaded = await import("../../game-server/src/core/room-lifecycle.js?v=three-hand-adoption");
  assert.equal(reloaded.syncActivity(table, 101000), true);
  assert.equal(table.emptySinceHands, 7);
  assert.equal(table.suspendedAt, undefined);
  assert.equal(table.hand.deadline, 104000);
  assert.equal(table.hand.botActAt, 102000);
  assert.equal(table.createdAt, 1000);
  assert.equal(table.expiresAt, 1000 + lifecycle.ROOM_LIFETIME_MS);
  reloaded.syncActivity(table, 102000);
  assert.equal(table.hand.deadline, 104000, "migration cannot repeatedly shift remaining time");
});

test("match-managed tournament rooms do not inherit cash-room suspension", () => {
  const table = { kind: "normal", roomType: 101, members: [], observers: [] };
  assert.equal(lifecycle.syncActivity(table), true);
  assert.equal(table.suspendedAt, undefined);
});

test("last-observer disconnect starts the allowance; no-hand idle time cannot consume it", async (t) => {
  const f = await fixture(t);
  await f.join();
  await f.handler.onClose(f.ws);
  assert.equal(f.table.suspendedAt, undefined);
  assert.equal(f.table.emptySinceHands, 0);
  f.advance(180000);
  await f.handler.tick();
  assert.equal(f.table.suspendedAt, undefined, "three minutes without a settlement is not three hands");
  assert.equal(f.table.emptySinceHands, 0);
  f.registry.bind(f.ws, f.session);
  await f.join();
  assert.equal(f.table.suspendedAt, undefined);
  assert.equal(f.table.emptySinceHands, undefined);
  assert.equal(f.table.members.length, 0);
  assert.deepEqual(f.table.observers.map((member) => member.uid), [42]);
});

test("post-hand bot cash-out cannot briefly turn a bot into a human and wake the room", async (t) => {
  const f = await fixture(t);
  f.table.members.push({ uid: 90000001, pos: 0, point: 50, bot: true });
  f.table.roomFeatures.settledInning = 1;
  f.table.currentInning = 1;
  f.table.startAt = f.now() + 6000;
  const paused = f.table.suspendedAt;
  f.advance(5000);
  await f.game.afterRound(f.ctx);
  assert.equal(f.table.suspendedAt, paused);
  assert.equal(f.table.startAt, f.table.createdAt + 6000);
  assert.equal(f.table.observers[0].bot, true);
  assert.equal(f.table.members.length, 0);
});
