import assert from "node:assert/strict";
import test from "node:test";
import { botChoose, createTexasTable, ensureBot, onTexasAction, tickTexas } from "./engine.js";
import { OP } from "./op.js";

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

test("two seated players start a hand and fold ends it", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  table.phase = "starting";
  table.startAt = 0;
  const io = mockIo();
  tickTexas(io, table, 1);
  assert.equal(table.phase, "playing");
  assert.equal(table.currentInning, 1);
  assert.ok(table.hand.pot >= 30);
  const actor = table.hand.actorUid;
  onTexasAction(io, table, { userId: actor }, { uid: actor, operation: 6, operationData: 0 });
  assert.equal(table.phase, "starting");
  assert.ok(io.messages.some((m) => m.msgid === 3432));
});

test("solo human gets a bot and bot checks when nothing to call", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push({ uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false });
  ensureBot(table);
  assert.equal(table.members.length, 2);
  assert.equal(table.members[1].bot, true);
  table.hand = { currentBet: 0 };
  table.members[1].streetBet = 0;
  table.members[1].point = 1000;
  const choice = botChoose(table, table.members[1]);
  assert.equal(choice.operation, OP.PASS);
});
