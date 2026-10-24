import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./create-handler.js";
import { createRegistry } from "./registry.js";
import { encodeFrame, decodeFrame } from "./codec.js";
import { SEND, PUSH } from "./messages.js";
import { HoldemGame } from "./games/holdem/HoldemGame.js";
import { beginHand } from "./games/holdem/engine.js";
import { OP } from "./games/holdem/op.js";
import { ROOM_LIFETIME_MS } from "./core/room-lifecycle.js";
import { ZjhGame } from "./games/zjh/ZjhGame.js";
import { beginHand as beginZjhHand } from "./games/zjh/engine.js";
import { ZJH_OP, ZJH_PUSH, ZJH_SEND } from "./games/zjh/messages.js";

async function fixture() {
  const registry = createRegistry();
  const game = new HoldemGame();
  const table = game.createTable(700000, 19, { game_room_config_id: 70 });
  registry.setTable(table.roomId, table, 1, "holdem");
  const credits = [];
  const errors = [];
  const runtime = { env: "dev", hotVersion: "expiry-test", registry, configs: [], findConfig: () => null,
    log: { info() {}, error: (...args) => errors.push(args) },
    wallet: { async load(session) { session.wallet = 500; },
      credit(session, amount) { session.wallet += amount; credits.push([session.userId, amount]); return { ok: true }; },
      async persist() {} },
  };
  const handler = await createHandler(runtime);
  const connect = (uid, point) => {
    const received = [];
    const ws = { readyState: 1, send: (raw) => received.push(decodeFrame(raw)) };
    const session = { userId: uid, roomId: table.roomId, gameId: "holdem", agentId: 1, inRoom: true, authenticated: true, wallet: 500 };
    registry.bind(ws, session);
    if (point != null) table.members.push({ uid, pos: table.members.length, point, name: String(uid), totalBet: 0 });
    else table.observers.push({ uid, name: String(uid) });
    return { ws, session, received };
  };
  return { registry, game, table, runtime, handler, connect, credits, errors };
}

test("empty room remains reusable until its eight-hour deadline", async () => {
  const { registry, table, handler, connect } = await fixture();
  const observer = connect(1);
  const expiresAt = table.expiresAt;
  await handler.onClose(observer.ws);
  await handler.tick();
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), table);
  assert.equal(table.expiresAt, expiresAt);
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  await handler.tick();
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), null);
  assert.deepEqual(registry.listAgentGameRooms(1, "holdem"), []);
});

test("expiry waits for the active hand, rejects new seats, then cashes out exactly once", async () => {
  const { registry, table, handler, connect, credits } = await fixture();
  const a = connect(1, 1000);
  const b = connect(2, 1000);
  const observer = connect(99);
  const ledger = table.roomFeatures;
  beginHand({ env: "dev", broadcast() {}, send() {}, forEachPlayer() {} }, table);
  const inning = table.currentInning;
  const remainingActor = table.hand.actorUid;
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  await handler.tick();
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), table);
  assert.equal(table.phase, "playing");
  assert.deepEqual(credits, []);
  await handler.onMessage(observer.ws, encodeFrame(SEND.SEND_SITDOWN, { position: 6 }));
  assert.equal(table.members.some((member) => member.uid === 99), false);
  const actor = remainingActor === 1 ? a : b;
  await handler.onMessage(actor.ws, encodeFrame(SEND.DZPK_SEND_ACTION, { operation: OP.ABANDON }));
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), null);
  assert.equal(table.currentInning, inning);
  assert.equal(credits.reduce((sum, [, amount]) => sum + amount, 0), 2000);
  assert.equal(a.session.wallet + b.session.wallet, 3000);
  for (const client of [a, b, observer]) {
    assert.equal(client.session.inRoom, false);
    assert.equal(client.received.filter((frame) => frame.msgid === PUSH.ROOM_DISSMISS).length, 1);
    const result = client.received.findIndex((frame) => frame.msgid === PUSH.DZPK_INNING_RESULT_PUSH);
    const close = client.received.findIndex((frame) => frame.msgid === PUSH.ROOM_DISSMISS);
    assert.ok(result >= 0 && close > result);
    await handler.onClose(client.ws);
  }
  await handler.tick();
  assert.equal(credits.length, 2);
  assert.equal(ledger.players.size, 0, "room ranking is released only after room destruction");
  assert.equal(table.roomFeatures, undefined);
});

test("expired starting room does not deal, and refund persistence retries without double credit", async () => {
  const { registry, table, handler, runtime, connect, credits, errors } = await fixture();
  const client = connect(1, 500);
  table.phase = "starting";
  table.startAt = 0;
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  let attempts = 0;
  runtime.wallet.persist = async () => { if (++attempts === 1) throw new Error("temporary failure"); };
  await handler.tick();
  await Promise.resolve();
  assert.equal(table.currentInning, 0);
  assert.equal(table.closing, true);
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), table);
  assert.equal(client.session.wallet, 1000);
  await handler.tick();
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), null);
  assert.deepEqual(credits, [[1, 500]]);
  assert.equal(errors.length, 1);
});

test("hot update preserves the creation deadline and clears old empty-room retirement flags", async () => {
  const { registry, table, runtime } = await fixture();
  table.retireWhenHandEnds = true;
  table.retired = true;
  const createdAt = table.createdAt;
  const next = await createHandler({ ...runtime, hotVersion: "expiry-test-2" });
  await next.tick();
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), table);
  assert.equal(table.createdAt, createdAt);
  assert.equal(table.expiresAt, createdAt + ROOM_LIFETIME_MS);
  assert.equal(table.retired, undefined);
});

test("a stale direct join cannot resurrect a destroyed room after hot reload", async () => {
  const { registry, table, runtime, handler, connect } = await fixture();
  const client = connect(1);
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  await handler.tick();
  const next = await createHandler({ ...runtime, hotVersion: "expiry-stale-join-test" });
  await next.onMessage(client.ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType: 19 }));
  assert.equal(registry.tables.size, 0);
  assert.equal(client.session.inRoom, false);
  assert.equal(client.received.at(-1).msgid, PUSH.ROOM_DISSMISS);
});

test("zjh also finishes the current hand at expiry and never starts a new one", async () => {
  const { registry, runtime, credits } = await fixture();
  registry.removeTable(700000, 1, "holdem");
  const game = new ZjhGame();
  const table = game.createTable(710000, 25, { game_room_config_id: 71, ante: 10 });
  table.members = [{ uid: 1, pos: 0, point: 500 }, { uid: 2, pos: 1, point: 500 }];
  registry.setTable(table.roomId, table, 1, "zjh");
  const received = [];
  const ws = { readyState: 1, send: (raw) => received.push(decodeFrame(raw)) };
  beginZjhHand({ env: "dev", broadcast() {}, send() {}, forEachPlayer() {} }, table);
  registry.bind(ws, { userId: table.hand.actorUid, roomId: table.roomId, gameId: "zjh", agentId: 1,
    wallet: 500, inRoom: true, authenticated: true });
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  const handler = await createHandler({ ...runtime, hotVersion: "zjh-expiry-test" });
  await handler.tick();
  assert.equal(table.phase, "playing");
  await handler.onMessage(ws, encodeFrame(ZJH_SEND.ACTION, { operation: ZJH_OP.FOLD }));
  assert.equal(registry.getTable(table.roomId, 1, "zjh"), null);
  assert.equal(table.currentInning, 1);
  assert.equal(credits.reduce((sum, [, amount]) => sum + amount, 0), 1000);
  assert.ok(received.findIndex((frame) => frame.msgid === ZJH_PUSH.INNING_RESULT) >= 0);
  assert.equal(received.at(-1).msgid, PUSH.ROOM_DISSMISS);
  game.startRound({ table, io: { broadcast() {}, forEachPlayer() {} } });
  assert.equal(table.currentInning, 1);
});

test("concurrent expiry ticks and disconnects share a single pending cash-out", async () => {
  const { table, runtime, handler, connect, registry, credits } = await fixture();
  const client = connect(1, 700);
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  let finish;
  let started;
  const saving = new Promise((resolve) => { started = resolve; });
  runtime.wallet.persist = async () => { started(); await new Promise((resolve) => { finish = resolve; }); };
  const first = handler.tick();
  await saving;
  const second = handler.tick();
  await handler.onClose(client.ws);
  const reloaded = await createHandler({ ...runtime, hotVersion: "pending-refund-test" });
  const third = reloaded.tick();
  assert.deepEqual(credits, [[1, 700]]);
  finish();
  await Promise.all([first, second, third]);
  assert.equal(registry.tables.size, 0);
  assert.equal(credits.length, 1);
});
