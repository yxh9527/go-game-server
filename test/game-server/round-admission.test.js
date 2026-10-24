import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "../../game-server/src/create-handler.js";
import { createRegistry } from "../../game-server/src/registry.js";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { SEND, PUSH } from "../../game-server/src/messages.js";
import { HoldemGame } from "../../game-server/src/games/holdem/HoldemGame.js";
import { ZjhGame } from "../../game-server/src/games/zjh/ZjhGame.js";
import { OP } from "../../game-server/src/games/holdem/op.js";
import { ZJH_OP, ZJH_PUSH, ZJH_SEND } from "../../game-server/src/games/zjh/messages.js";
import { ranking, recordCarryIn } from "../../game-server/src/core/room-features.js";
import { ROOM_LIFETIME_MS } from "../../game-server/src/core/room-lifecycle.js";

async function fixture(roomType = 19) {
  const game = roomType === 25 ? new ZjhGame() : new HoldemGame();
  const registry = createRegistry();
  const table = game.createTable(700019, roomType, { game_room_config_id: 70, carry_min: 500 });
  table.botTarget = 0;
  registry.setTable(table.roomId, table, 1, game.id);
  const credits = [], errors = [], persisted = [];
  const runtime = { hotVersion: 'admission-test', env: "dev", registry, configs: [], findConfig: () => null,
    log: { info() {}, error: (...args) => errors.push(args) },
    wallet: {
      async load(session) { session.wallet = 1000; },
      credit(session, amount) { credits.push([session.userId, amount]); session.wallet += amount; return { ok: true }; },
      debit(session, amount) { if (session.wallet < amount) return { ok: false };
        session.wallet -= amount; return { ok: true }; },
      async persist(session) { persisted.push([session.userId, session.wallet]); },
    },
  };
  const handler = await createHandler(runtime);
  const connect = (uid, point, bot = false) => {
    const received = [];
    const ws = { readyState: 1, send: (raw) => received.push(decodeFrame(raw)) };
    const session = { userId: uid, name: String(uid), roomId: table.roomId, gameId: game.id,
      agentId: 1, inRoom: true, authenticated: true, wallet: 1000 };
    if (!bot) registry.bind(ws, session);
    let member;
    if (point != null) {
      member = { uid, name: String(uid), point, pos: table.members.length, state: 1, totalBet: 0, bot };
      table.members.push(member);
      recordCarryIn(table, member, point);
    } else table.observers.push({ uid, name: String(uid), point: session.wallet });
    return { ws, session, member, received };
  };
  return { game, table, registry, handler, runtime, connect, credits, persisted, errors };
}

for (const roomType of [19, 25]) {
  test('cash room ' + roomType + ' forces insufficient chips to stand only after real settlement', async () => {
    const { table, handler, connect, credits } = await fixture(roomType);
    const a = connect(1, 500), b = connect(2, 500);
    table.phase = "starting";
    table.startAt = 0;
    await handler.tick();
    const actor = table.hand.actorUid === 1 ? a : b;
    const winner = actor === a ? b : a;
    assert.ok(actor.member.point < table.carryMin, "blinds or ante lower chips during the hand");
    await handler.tick();
    assert.equal(table.members.length, 2, "no removal before settlement");
    assert.deepEqual(credits, []);
    a.received.length = b.received.length = 0;
    await handler.onMessage(actor.ws, encodeFrame(roomType === 25 ? ZJH_SEND.ACTION : SEND.DZPK_SEND_ACTION,
      { operation: roomType === 25 ? ZJH_OP.FOLD : OP.ABANDON }));
    const resultId = roomType === 25 ? ZJH_PUSH.INNING_RESULT : PUSH.DZPK_INNING_RESULT_PUSH;
    const messages = actor.received;
    const resultIndex = messages.findIndex((frame) => frame.msgid === resultId);
    const result = messages[resultIndex].payload.find((row) => row.uid === actor.session.userId);
    assert.ok(result.point < table.carryMin && result.point > 0);
    assert.ok(messages.findIndex((frame) => frame.msgid === PUSH.USER_STANDUP_ROOM) > resultIndex);
    assert.ok(!messages.slice(resultIndex + 1).some((frame) => frame.msgid === PUSH.ROOM_INFO),
      "stand-up must not reset the settlement animation");
    assert.equal(table.members.length, 1);
    assert.equal(table.members[0].uid, winner.session.userId);
    assert.equal(table.observers[0].uid, actor.session.userId);
    assert.equal(actor.session.wallet, 1000 + result.point);
    assert.equal(actor.session.inRoom, true);
    assert.deepEqual(credits, [[actor.session.userId, result.point]]);
    const report = ranking(table);
    const row = report.userList.find((player) => player.uid === actor.session.userId);
    assert.equal(row.totalHands, 1);
    assert.equal(row.winLostScore, result.score);
    assert.equal(row.carryOutPoint, result.point);
    assert.equal(row.totalPoint, 500);
    assert.equal(row.onTableFlag, 0);
    assert.equal(actor.session.wallet + winner.session.wallet + winner.member.point, 3000);
    await handler.tick();
    assert.equal(credits.length, 1);
    await handler.onClose(actor.ws);
    assert.equal(credits.filter(([, amount]) => amount > 0).length, 1, "disconnect cannot refund twice");
  });
}

test("post-hand check includes zero/low bots, keeps exact minimum and protects the 12-second buy-in", async () => {
  const { table, handler, connect, credits } = await fixture();
  const low = connect(1, 499), exact = connect(2, 500), empty = connect(3, 0);
  const bot = connect(90000001, 200, true);
  const waiting = connect(4, 0);
  waiting.member.carryDeadline = Date.now() + 12000;
  table.currentInning = table.roomFeatures.settledInning = 1;
  table.phase = "starting";
  table.startAt = 0;
  await handler.tick();
  assert.deepEqual(table.members.map((member) => member.uid), [2, 4]);
  assert.equal(exact.member.point, 500);
  assert.equal(waiting.member.point, 0);
  assert.equal(low.session.wallet, 1499);
  assert.equal(empty.session.wallet, 1000);
  assert.deepEqual(credits, [[1, 499]]);
  assert.ok(table.observers.some((member) => member.uid === bot.member.uid && member.bot && member.point === 200));
  assert.equal(ranking(table).userList.find((row) => row.uid === bot.member.uid).carryOutPoint, 200);
  assert.equal(table.phase, "idle", "only one funded eligible player remains");
  assert.equal(table.currentInning, 1, "no next hand is dealt before the check");
});

test("concurrent ticks, disconnect and hot reload share one post-hand cash-out", async () => {
  const { table, handler, runtime, connect, credits } = await fixture();
  const low = connect(1, 100);
  connect(2, 500);
  table.currentInning = table.roomFeatures.settledInning = 1;
  table.phase = "starting";
  table.startAt = 0;
  let finishPersist;
  let announcePersist;
  const entered = new Promise((resolve) => { announcePersist = resolve; });
  const gate = new Promise((resolve) => { finishPersist = resolve; });
  runtime.wallet.persist = async () => { announcePersist(); await gate; };
  const first = handler.tick();
  await entered;
  const next = await createHandler({ ...runtime, hotVersion: 'admission-hot-reload' });
  const second = next.tick();
  const disconnect = next.onClose(low.ws);
  assert.equal(table.currentInning, 1);
  assert.equal(credits.length, 1);
  finishPersist();
  await Promise.all([first, second, disconnect]);
  assert.equal(credits.filter(([, amount]) => amount > 0).length, 1);
  assert.equal(low.session.wallet, 1100);
  assert.equal(table.members.some((member) => member.uid === 1), false);
  assert.equal(table.observers.some((member) => member.uid === 1), false, "closed connection leaves the room");
  assert.equal(table.admissionCheckedInning, 1);
});

test("failed post-hand persistence retries without repeated credit and blocks the next hand", async () => {
  const { table, handler, runtime, connect, credits, errors } = await fixture();
  const low = connect(1, 100);
  connect(2, 500);
  connect(3, 500);
  table.currentInning = table.roomFeatures.settledInning = 1;
  table.phase = "starting";
  table.startAt = 0;
  let attempts = 0;
  runtime.wallet.persist = async () => { if (++attempts === 1) throw new Error("storage unavailable"); };
  await handler.tick();
  assert.equal(table.currentInning, 1);
  assert.equal(low.session.wallet, 1100);
  assert.ok(table.roundAdmission);
  assert.equal(low.member.point, 0, "credited chips no longer belong to the table");
  await handler.tick();
  assert.equal(table.currentInning, 1, "cleanup completes before the next dealing tick");
  assert.equal(table.roundAdmission, undefined);
  assert.deepEqual(credits, [[1, 100]]);
  assert.equal(errors.length, 1);
  assert.equal(ranking(table).userList.find((row) => row.uid === 1).carryOutPoint, 100);
});

test("rejected cash-out preserves chips and eight-hour closure waits for admission retry", async () => {
  const { table, handler, runtime, connect, credits, registry } = await fixture();
  const low = connect(1, 100);
  const normalCredit = runtime.wallet.credit;
  let attempts = 0;
  runtime.wallet.credit = (session, amount) => ++attempts === 1 ? { ok: false } : normalCredit(session, amount);
  table.currentInning = table.roomFeatures.settledInning = 1;
  await handler.tick();
  assert.equal(low.member.point, 100);
  assert.equal(low.session.wallet, 1000);
  table.createdAt = Date.now() - ROOM_LIFETIME_MS;
  await handler.tick();
  await handler.tick();
  assert.deepEqual(credits, [[1, 100]]);
  assert.equal(low.session.wallet, 1100);
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), null);
});

test("pending initial buy-in does not turn a whole-hand zero balance into an exemption", async () => {
  const { table, handler, connect } = await fixture();
  const allIn = connect(1, 0);
  connect(2, 500);
  allIn.member.allIn = true;
  allIn.member.hole = [1, 2];
  table.phase = "playing";
  table.hand = { actorUid: 2, deadline: Date.now() + 100000 };
  await handler.tick();
  assert.ok(table.members.includes(allIn.member));
  table.hand = null;
  table.phase = "idle";
  table.currentInning = table.roomFeatures.settledInning = 1;
  await handler.tick();
  assert.equal(table.members.includes(allIn.member), false);
  assert.ok(table.observers.some((member) => member.uid === 1));
});

test("cash-table admission policy does not remove tournament players", async () => {
  const { table, handler, connect } = await fixture(101);
  const player = connect(1, 100);
  table.currentInning = table.roomFeatures.settledInning = 1;
  await handler.tick();
  assert.ok(table.members.includes(player.member));
});

test("robot turn settlement runs admission through tick and preserves the next hand delay", async () => {
  const { table, handler, connect, credits } = await fixture();
  const human = connect(1, 500);
  const bot = connect(90000001, 500, true);
  table.phase = "starting";
  table.startAt = 0;
  await handler.tick();
  assert.equal(table.hand.actorUid, bot.member.uid);
  table.hand.botActAt = 0;
  bot.member.hole = [];
  await handler.tick();
  assert.equal(table.hand, null);
  assert.equal(table.members.includes(bot.member), false);
  assert.ok(table.members.includes(human.member));
  assert.equal(credits.length, 0, "robot chips never credit human wallets");
  const resultIndex = human.received.findIndex((frame) => frame.msgid === PUSH.DZPK_INNING_RESULT_PUSH);
  const standIndex = human.received.findIndex((frame) => frame.msgid === PUSH.USER_STANDUP_ROOM);
  assert.ok(resultIndex >= 0 && standIndex > resultIndex);
  assert.ok(table.startAt > Date.now(), "settlement animation keeps its original delay");
});

test("every successive hand checks the final balance again", async () => {
  const { table, handler, connect, credits } = await fixture();
  const player = connect(1, 500);
  table.currentInning = table.roomFeatures.settledInning = 1;
  await handler.tick();
  assert.ok(table.members.includes(player.member));
  player.member.point = 499;
  table.currentInning = table.roomFeatures.settledInning = 2;
  await handler.tick();
  assert.equal(table.members.includes(player.member), false);
  assert.deepEqual(credits, [[1, 499]]);
  assert.equal(table.admissionCheckedInning, 2);
});
