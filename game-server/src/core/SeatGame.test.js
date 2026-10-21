import assert from "node:assert/strict";
import test from "node:test";
import { SeatGame } from "./SeatGame.js";
import { PUSH } from "../messages.js";

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

test("SeatGame sit, buy-in and queue start", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const a = { userId: 1, name: "a", wallet: 500 };
  const b = { userId: 2, name: "b", wallet: 500 };
  const ctxA = mockCtx(game, table, a);
  game.onJoin(ctxA);
  assert.equal(a.wallet, 400);
  assert.equal(table.members.length, 1);
  assert.equal(table.phase, "idle");
  const ctxB = mockCtx(game, table, b);
  game.onJoin(ctxB);
  assert.equal(table.members.length, 2);
  assert.equal(table.phase, "starting");
  assert.ok(ctxA.messages.some((m) => m.msgid === PUSH.JOIN_ROOM));
  const join = ctxA.messages.find((m) => m.msgid === PUSH.JOIN_ROOM);
  assert.equal(join.payload.userInfo.uid, 1);
  assert.ok(ctxB.messages.some((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast));
  const info = ctxB.messages.find((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast).payload;
  assert.equal(info.memberList.length, 3);
  assert.equal(info.memberList[0].userInfo.uid, 1);
  assert.equal(info.memberList[1].userInfo.uid, 2);
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
  assert.ok(sit.messages.some((m) => m.msgid === PUSH.CARRYIN_RESULT && m.payload.carryMin === 50));
  const buy = mockCtx(game, table, a, { carryIn: 100 });
  game.onCarryScore(buy);
  assert.equal(table.members[0].point, 100);
  assert.equal(a.wallet, 400);
  const result = buy.messages.find((m) => m.msgid === PUSH.CARRY_SCORE_RESULT);
  assert.equal(result.payload.state, 0);
  assert.equal(result.payload.carryIn, 100);
});

test("SeatGame leave returns chips and clears empty table", () => {
  const game = new DemoSeat();
  const table = game.createTable(1, 1, {});
  const a = { userId: 1, name: "a", wallet: 100 };
  game.onJoin(mockCtx(game, table, a));
  const cash = game.onLeave(mockCtx(game, table, a));
  assert.equal(cash, 100);
  assert.equal(table.members.length, 0);
});
