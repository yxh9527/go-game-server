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
  assert.ok(ctxB.messages.some((m) => m.msgid === PUSH.ROOM_INFO && m.broadcast));
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
