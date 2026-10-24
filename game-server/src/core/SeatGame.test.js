import assert from "node:assert/strict";
import test from "node:test";
import { SeatGame } from "./SeatGame.js";
import { PUSH } from "../messages.js";
import { ranking } from "./room-features.js";
import { HoldemGame } from "../games/holdem/HoldemGame.js";
import { ZjhGame } from "../games/zjh/ZjhGame.js";

class DemoSeat extends SeatGame {
  constructor() {
    super({
      id: "demo",
      kind: "normal",
      roomTypes: [1],
      confRoomType: "demo",
      minPeople: 2,
      maxPeople: 3,
      startDelayMs: 10,
    });
  }

  buyIn(_table, session) {
    return Math.min(session.wallet, 100);
  }
}

function mockCtx(game, table, session, body = {}) {
  const messages = [];
  const io = {
    broadcast(msgid, payload) {
      messages.push({ msgid, payload, broadcast: true });
    },
  };
  return {
    table,
    session,
    body,
    io,
    messages,
    send(msgid, payload) {
      messages.push({ msgid, payload });
    },
  };
}

test("SeatGame joins as observer and starts after explicit sit and carry-in", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const a = { userId: 1, name: "a", wallet: 500 };
  const b = { userId: 2, name: "b", wallet: 500 };
  const ctxA = mockCtx(game, table, a);
  game.onJoin(ctxA);
  assert.equal(a.wallet, 500);
  assert.equal(table.members.length, 0);
  assert.equal(table.phase, "idle");
  const ctxB = mockCtx(game, table, b);
  game.onJoin(ctxB);
  for (const [ctx, session] of [[ctxA, a], [ctxB, b]]) {
    game.onSitDown(ctx);
    game.onCarryScore({ ...ctx, body: { carryIn: 1 } });
    assert.equal(session.wallet, 400);
  }
  assert.equal(table.members.length, 2);
  assert.equal(table.phase, "starting");
  assert.ok(ctxA.messages.some((m) => m.msgid === PUSH.JOIN_ROOM));
  const join = ctxA.messages.find((m) => m.msgid === PUSH.JOIN_ROOM);
  assert.equal(join.payload.userInfo.uid, 1);
  assert.ok(ctxB.messages.some((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast));
  const info = ctxB.messages.filter((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast).at(-1).payload;
  assert.equal(info.memberList.length, 3);
  assert.ok(info.memberList.some((item) => item.userInfo?.uid === 1));
  assert.ok(info.memberList.some((item) => item.userInfo?.uid === 2));
  assert.equal(info.memberList[2].pos, 2);
});

test("SeatGame observer join does not sit", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const a = { userId: 1, name: "a", wallet: 500 };
  const ctx = mockCtx(game, table, a, { isOb: true });
  game.onJoin(ctx);
  assert.equal(table.members.length, 0);
  assert.equal(table.observers.length, 1);
  assert.equal(a.wallet, 500);
  assert.equal(ctx.messages.some((m) => m.msgid === PUSH.JOIN_ROOM), false);
  const info = ctx.messages.find((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast).payload;
  assert.equal(info.OBmemberList[0].userInfo.uid, 1);
});

test("SeatGame rejects a full table before charging and keeps the player spectating", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  table.members = Array.from({ length: 3 }, (_, pos) => ({ uid: pos + 1, pos, point: 100 }));
  const session = { userId: 4, name: "waiting", wallet: 500 };
  game.onJoin(mockCtx(game, table, session));
  const result = game.sit(table, session, mockCtx(game, table, session), { buyIn: 100, pos: 0 });
  assert.equal(result, null);
  assert.equal(session.wallet, 500);
  assert.equal(table.members.length, 3);
  assert.equal(table.observers[0].uid, 4);
});

test("SeatGame sitdown then carry-in seats the observer", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  table.carryMin = 50;
  const a = { userId: 1, name: "a", wallet: 500 };
  game.onJoin(mockCtx(game, table, a, { isOb: true }));
  const sit = mockCtx(game, table, a, { position: 2 });
  game.onSitDown(sit);
  assert.equal(table.members.length, 1);
  assert.equal(table.members[0].pos, 2);
  assert.equal(table.members[0].point, 0);
  assert.equal(table.observers.length, 0);
  const carryPanel = sit.messages.find((m) => m.msgid === PUSH.CARRYIN_RESULT)?.payload;
  assert.equal(carryPanel.carryMin, 50);
  assert.equal(carryPanel.carryDefault, 50);
  assert.equal(carryPanel.carryMax, 500);
  assert.equal(carryPanel.configCarryMax, 500);
  assert.equal(carryPanel.carryBalance, 0);
  assert.equal(carryPanel.carryCustom, 50);
  assert.ok(Number.isFinite(carryPanel.leftTime));
  const buy = mockCtx(game, table, a, { carryIn: 1 });
  game.onCarryScore(buy);
  assert.equal(table.members[0].point, 100);
  assert.equal(a.wallet, 400);
  const result = buy.messages.find((m) => m.msgid === PUSH.CARRY_SCORE_RESULT);
  assert.equal(result.payload.state, 0);
  assert.equal(result.payload.carryIn, 100);
  assert.equal(result.payload.carryBalance, 100);
});

test("SeatGame leave returns chips and clears empty table", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const a = { userId: 1, name: "a", wallet: 100 };
  game.onJoin(mockCtx(game, table, a));
  game.onSitDown(mockCtx(game, table, a));
  game.onCarryScore(mockCtx(game, table, a, { carryIn: 1 }));
  const cash = game.onLeave(mockCtx(game, table, a));
  assert.equal(cash, 100);
  assert.equal(table.members.length, 0);
});

test("SeatGame converts online carry-in display units to score before validating", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  table.carryMin = 500;
  const a = { userId: 1, name: "a", wallet: 1_000_000 };
  game.onJoin(mockCtx(game, table, a, { isOb: true }));
  game.onSitDown(mockCtx(game, table, a, { position: 6 }));

  const buy = mockCtx(game, table, a, { carryIn: 25 });
  game.onCarryScore(buy);

  assert.equal(a.wallet, 997_500);
  assert.equal(table.members[0].point, 2_500);
  const result = buy.messages.find((m) => m.msgid === PUSH.CARRY_SCORE_RESULT);
  assert.deepEqual(result.payload, {
    uid: 1,
    state: 0,
    carryIn: 2_500,
    carryBalance: 2_500,
  });
});

test("seat is occupied immediately, expires at 12 seconds and becomes reusable", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "waiting", wallet: 500, inRoom: true };
  const ctx = mockCtx(game, table, session, { position: 2 });
  game.onJoin(ctx);
  game.onSitDown(ctx);
  const member = table.members[0];
  assert.equal(member.pos, 2);
  assert.equal(member.point, 0);
  assert.equal(session.wallet, 500);
  assert.equal(table.observers.length, 0);
  assert.equal(game.seated(table).length, 0, "unfunded seat is excluded from dealing");
  const panel = ctx.messages.find((m) => m.msgid === PUSH.CARRYIN_RESULT).payload;
  assert.equal(panel.leftTime, 12000);
  assert.equal(panel.isByServerSettle, true);
  assert.equal(game.roomInfo(table).memberList[2].carryLeftTime, 12000);
  now += 11999;
  game.tick(ctx);
  assert.equal(table.members[0], member);
  assert.equal(game.carryPanel(table, session).leftTime, 1);
  now += 1;
  const tick = { table, io: { ...ctx.io, forEachPlayer: (fn) => fn({ ...session }) } };
  ctx.messages.length = 0;
  game.tick(tick);
  assert.equal(table.members.length, 0);
  assert.equal(table.observers[0].uid, 1);
  assert.equal(table.observers[0].point, 500);
  assert.equal(session.wallet, 500);
  assert.equal(session.inRoom, true);
  assert.deepEqual(ctx.messages.map((m) => m.msgid), [
    PUSH.USER_STANDUP_ROOM, PUSH.ROOM_INFO, PUSH.DZPK_PUSH_RANKINGLIST, PUSH.DZPK_PUSH_WATCHGAME,
  ]);
  assert.equal(ctx.messages[0].payload, 1, "stand-up payload is a numeric uid");
  const row = ranking(table).userList.find((item) => item.uid === 1);
  assert.equal(row.totalPoint, 0);
  assert.equal(row.carryOutPoint, 0);
  assert.equal(row.onTableFlag, 0);
  const count = ctx.messages.length;
  game.tick(tick);
  assert.equal(ctx.messages.length, count, "timeout is idempotent");
  const next = { userId: 2, name: "next", wallet: 500 };
  game.onSitDown(mockCtx(game, table, next, { position: 2 }));
  assert.equal(table.members[0].uid, 2);
  assert.equal(table.members[0].pos, 2);
});

test("failed amounts and insufficient balance keep the original deadline", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "waiting", wallet: 500 };
  const ctx = mockCtx(game, table, session);
  game.onSitDown(ctx);
  const deadline = table.members[0].carryDeadline;
  for (const amount of [0, -1, NaN, Infinity, "NaN", undefined, 0.001, 1e308, 6]) {
    now += 100;
    game.onCarryScore({ ...ctx, body: { carryIn: amount } });
    assert.equal(ctx.messages.at(-1).payload.state, 1);
    assert.equal(table.members[0].carryDeadline, deadline);
    assert.equal(table.members[0].point, 0);
    assert.equal(session.wallet, 500);
  }
  table.carryMin = 200;
  game.onCarryScore({ ...ctx, body: { carryIn: 1 } });
  assert.equal(ctx.messages.at(-1).payload.state, 1);
  assert.equal(table.members[0].carryDeadline, deadline);
  now = deadline;
  game.tick(ctx);
  assert.equal(table.members.length, 0);
});

test("successful buy-in before the deadline cancels timeout, including subsequent all-in", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "player", wallet: 500 };
  const ctx = mockCtx(game, table, session);
  game.onSitDown(ctx);
  now += 11999;
  game.onCarryScore({ ...ctx, body: { carryIn: 1 } });
  const member = table.members[0];
  assert.equal(member.point, 100);
  assert.equal(session.wallet, 400);
  assert.equal(member.carryDeadline, undefined);
  assert.equal(game.carryPanel(table, session).isByServerSettle, false);
  assert.equal(game.roomInfo(table).memberList[0].carryLeftTime, 0);
  member.point = 0;
  member.allIn = true;
  member.hole = [1, 2];
  now += 12000;
  game.tick(ctx);
  assert.equal(table.members[0], member, "all-in is not an unfunded pending seat");
  game.onSitDown(ctx);
  assert.equal(member.carryDeadline, undefined, "repeat sit does not re-arm a funded seat");
});

test("late buy-in is rejected even before tick and cannot implicitly reseat", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "player", wallet: 500 };
  const ctx = mockCtx(game, table, session);
  game.onSitDown(ctx);
  now += 12000;
  game.onCarryScore({ ...ctx, body: { carryIn: 1 } });
  assert.equal(table.members.length, 0);
  assert.equal(session.wallet, 500);
  assert.equal(ctx.messages.filter((m) => m.msgid === PUSH.CARRY_SCORE_RESULT).at(-1).payload.state, 1);
  ctx.messages.length = 0;
  game.onCarryIn(ctx);
  game.onCarryScore({ ...ctx, body: { carryIn: 1 } });
  assert.equal(table.members.length, 0);
  assert.equal(session.wallet, 500);
  assert.ok(!ctx.messages.some((m) => [PUSH.JOIN_ROOM, PUSH.CARRYIN_RESULT].includes(m.msgid)));
  game.onSitDown(ctx);
  assert.equal(table.members.length, 1);
  assert.equal(table.members[0].carryDeadline, now + 12000);
});

test("duplicate sit, reopened panel, reconnect and hot update never extend the deadline", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "player", wallet: 500 };
  const ctx = mockCtx(game, table, session);
  game.onSitDown(ctx);
  const deadline = table.members[0].carryDeadline;
  now += 4000;
  game.onSitDown(ctx);
  game.onCarryIn(ctx);
  game.onLoginRoom(ctx);
  assert.equal(table.members[0].carryDeadline, deadline);
  assert.equal(game.carryPanel(table, session).leftTime, 8000);
  const { SeatGame: UpdatedGame } = await import('./SeatGame.js?v=carry-deadline-test');
  const updated = new UpdatedGame(game.config);
  now += 3000;
  updated.onLoginRoom(ctx);
  assert.equal(updated.roomInfo(table).memberList[0].carryLeftTime, 5000);
  updated.onCarryIn(ctx);
  assert.equal(ctx.messages.at(-1).payload.leftTime, 5000);
  assert.equal(table.members[0].carryDeadline, deadline);
  now = deadline;
  updated.tick(ctx);
  assert.equal(table.members.length, 0);
});

test("pending carry timeout does not fold or alter a running robot hand in either game", (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  for (const [game, roomType] of [[new HoldemGame(), 19], [new ZjhGame(), 25]]) {
    const table = game.createTable(700009, roomType, {});
    const ctx = mockCtx(game, table, { userId: 1, name: "waiting", wallet: 500 });
    game.onSitDown(ctx);
    table.phase = "playing";
    table.hand = { actorUid: 900, pot: 300, state: "flop" };
    const before = JSON.stringify(table.hand);
    t.mock.method(game, "abandonIfPlaying", () => assert.fail("pending seat must not fold"));
    t.mock.method(game, "playTick", () => {});
    now += 12000;
    game.tick(ctx);
    assert.equal(table.phase, "playing");
    assert.equal(JSON.stringify(table.hand), before);
    assert.equal(table.members.some((member) => member.uid === 1), false);
    assert.equal(table.observers.some((member) => member.uid === 1), true);
  }
});

test("client closing the carry panel releases the pending seat without folding or refunding", (t) => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const session = { userId: 1, name: "waiting", wallet: 500 };
  const ctx = mockCtx(game, table, session);
  game.onSitDown(ctx);
  table.phase = "playing";
  table.hand = { pot: 300, actorUid: 900 };
  t.mock.method(game, "abandonIfPlaying", () => assert.fail("pending seat cannot fold"));
  ctx.wallet = { credit() { assert.fail("pending seat has no refund"); } };
  game.onStandUp(ctx);
  assert.equal(table.members.length, 0);
  assert.equal(table.observers[0].uid, 1);
  assert.equal(session.wallet, 500);
  assert.equal(table.hand.pot, 300);
});
