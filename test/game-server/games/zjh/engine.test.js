import assert from "node:assert/strict";
import test from "node:test";
import { beginHand, tickPlaying } from "../../../../game-server/src/games/zjh/engine.js";
import { ZJH_OP } from "../../../../game-server/src/games/zjh/messages.js";
import { ZjhGame } from "../../../../game-server/src/games/zjh/ZjhGame.js";

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

test("zjh uses SeatGame and starts a hand with ante", () => {
  const game = new ZjhGame();
  assert.equal(game.kind, "normal");
  const table = game.createTable(25010000, 25, { ante: 10, carry_min: 100 });
  table.members.push(
    { uid: 1, name: "a", point: 500, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 500, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const io = mockIo();
  beginHand(io, table);
  assert.equal(table.phase, "playing");
  assert.equal(table.hand.pot, 20);
  assert.equal(table.members[0].hole.length, 3);
  tickPlaying(io, table, table.hand.deadline + 1);
  assert.ok(io.messages.some((m) => m.payload?.operation === ZJH_OP.FOLD || m.msgid === 3732 || table.members.some((p) => p.folded)));
});
