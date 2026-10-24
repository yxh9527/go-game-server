import assert from "node:assert/strict";
import test from "node:test";
import { botChoose, ensureBots, scheduleTurn, tickBot } from "../../../../game-server/src/games/holdem/robot.js";
import { beginHand, createTexasTable, onTexasAction, tickPlaying } from "../../../../game-server/src/games/holdem/engine.js";
import { OP } from "../../../../game-server/src/games/holdem/op.js";
import { PUSH } from "../../../../game-server/src/messages.js";

function fixture({ hole = [0, 13], board = [], bet = 20, stack = 2000, pot = 200 } = {}) {
  const actor = { uid: 90000001, pos: 0, bot: true, hole, point: stack, streetBet: 0, totalBet: 20 };
  const rival = { uid: 2, pos: 1, point: 2000, streetBet: bet, totalBet: pot - 20 };
  const table = {
    bigBlind: 20, betTime: 11, members: [actor, rival],
    hand: { board, street: board.length === 0 ? "BET_PERFLOP" : "BET_FLOP",
      currentBet: bet, minRaise: 20, pot, acted: new Set(), actorUid: actor.uid },
  };
  return { table, actor, rival };
}

function seeded(seed) {
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function ioFor(messages = []) {
  return { send() {}, forEachPlayer() {}, broadcast(msgid, payload) { messages.push({ msgid, payload }); } };
}

test("strong holes and made hands do not fold at a fixed eight-blind threshold", () => {
  for (const cards of [
    { hole: [0, 13], board: [] },
    { hole: [0, 13], board: [26, 12, 24] },
    { hole: [0, 12], board: [9, 10, 11, 27, 41] },
  ]) {
    const { table, actor } = fixture({ ...cards, bet: 200, pot: 300 });
    assert.notEqual(botChoose(table, actor, () => 0.9).operation, OP.ABANDON);
  }
});

test("weak cards can fold even when the call would use the whole stack", () => {
  const { table, actor } = fixture({ hole: [1, 19], board: [0, 25, 37, 49, 7], bet: 300, stack: 300, pot: 400 });
  assert.equal(botChoose(table, actor, () => 0.9).operation, OP.ABANDON);
});

test("free checks never turn into a fold, and missing holes fail safely", () => {
  const { table, actor } = fixture({ hole: [1, 19], board: [0, 25, 37, 49, 7], bet: 0 });
  for (const roll of [0, 0.2, 0.5, 0.99]) assert.notEqual(botChoose(table, actor, () => roll).operation, OP.ABANDON);
  actor.hole = [];
  assert.deepEqual(botChoose(table, actor), { operation: OP.PASS, operationData: 0 });
});

test("flush draw continues at a cheap price but can fold to an expensive call", () => {
  const cheap = fixture({ hole: [0, 11], board: [2, 8, 25], bet: 20, stack: 250, pot: 220 });
  assert.notEqual(botChoose(cheap.table, cheap.actor, () => 0.9).operation, OP.ABANDON);
  const expensive = fixture({ hole: [0, 11], board: [2, 8, 25], bet: 200, stack: 250, pot: 240 });
  assert.equal(botChoose(expensive.table, expensive.actor, () => 0.9).operation, OP.ABANDON);
});

test("robot only reads its own holes and public information", () => {
  const { table, actor, rival } = fixture({ hole: [0, 12], board: [9, 10, 11], bet: 200, pot: 300 });
  const forbidden = { get() { throw new Error("private cards accessed"); } };
  Object.defineProperty(table.hand, "deck", forbidden);
  Object.defineProperty(table.hand, "deckPos", forbidden);
  Object.defineProperty(rival, "hole", forbidden);
  assert.notEqual(botChoose(table, actor, () => 0.9).operation, OP.ABANDON);
});

test("value bets use normal action units and the shared engine applies that target", () => {
  const table = createTexasTable(770001, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  ensureBots(table, 2);
  const io = ioFor();
  beginHand(io, table);
  const actor = table.members.find((member) => member.uid === table.hand.actorUid);
  actor.hole = [0, 13];
  const before = { point: actor.point, bet: actor.streetBet, pot: table.hand.pot };
  const choice = botChoose(table, actor, () => 0.1);
  assert.equal(choice.operation, OP.ADD);
  const target = Math.round(choice.operationData * 100);
  assert.ok(target >= table.hand.currentBet + table.hand.minRaise);
  onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, ...choice });
  assert.equal(actor.streetBet, target);
  assert.equal(actor.point, before.point - (target - before.bet));
  assert.equal(table.hand.pot, before.pot + target - before.bet);
});

test("strong hands sometimes bet and sometimes check; sizing stays legal", () => {
  const { table, actor } = fixture({ hole: [0, 12], board: [9, 10, 11, 27, 41], bet: 0 });
  const bet = botChoose(table, actor, () => 0.1);
  assert.equal(bet.operation, OP.BET);
  assert.ok(bet.operationData * 100 >= table.hand.minRaise);
  assert.ok(bet.operationData * 100 <= actor.point);
  assert.equal(botChoose(table, actor, () => 0.99).operation, OP.PASS);
});

test("robots do not raise against all-in rivals or count empty seats as opponents", () => {
  const { table, actor, rival } = fixture({ hole: [0, 12], board: [9, 10, 11, 27, 41], bet: 200, pot: 300 });
  rival.allIn = true;
  rival.point = 0;
  table.members.push({ uid: 3, point: 2000, totalBet: 0, streetBet: 0 });
  assert.equal(botChoose(table, actor, () => 0).operation, OP.FOLLOW);
});

test("robot thinking time varies and is bounded by the action deadline", () => {
  const { table, actor } = fixture();
  table.hand.deadline = 12000;
  scheduleTurn(table, actor, 1000, () => 0);
  const first = table.hand.botActAt;
  scheduleTurn(table, actor, 1000, () => 0.9);
  assert.ok(table.hand.botActAt > first);
  assert.ok(table.hand.botActAt < table.hand.deadline);
  table.hand.deadline = 1200;
  scheduleTurn(table, actor, 1000, () => 0.9);
  assert.ok(table.hand.botActAt <= 1100);
  const calls = [];
  assert.equal(tickBot(table, actor, 1000, (...args) => calls.push(args)), true);
  assert.equal(calls.length, 0);
  tickBot(table, actor, 1100, (...args) => calls.push(args), () => 0.9);
  assert.equal(calls.length, 1);
  actor.bot = false;
  assert.equal(tickBot(table, actor, 1200, (...args) => calls.push(args)), false);
  assert.equal(calls.length, 1);
});

test("filling robot vacancies preserves unique ids, seats and human members", () => {
  const table = { bigBlind: 20, carryMin: 500, members: [] };
  ensureBots(table, 4);
  const removed = table.members.splice(1, 1)[0];
  table.members.push({ uid: 42, pos: 6, point: 0 });
  ensureBots(table);
  assert.equal(table.members.length, 5);
  assert.equal(new Set(table.members.map((member) => member.uid)).size, 5);
  assert.equal(new Set(table.members.map((member) => member.pos)).size, 5);
  assert.ok(table.members.some((member) => member.uid === removed.uid));
  assert.equal(table.members.find((member) => member.uid === 42).point, 0);
});

test("seeded robot tables reach later streets, settle and conserve chips", (t) => {
  t.mock.method(Math, "random", seeded(20261023));
  const reached = { BET_FLOP: 0, BET_TURN: 0, BET_RIVER: 0 };
  const operations = new Set();
  for (let hand = 0; hand < 80; hand += 1) {
    const table = createTexasTable(780000 + hand, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
    ensureBots(table, 3 + hand % 4);
    const initialChips = table.members.reduce((sum, member) => sum + member.point, 0);
    const messages = [];
    const io = ioFor(messages);
    beginHand(io, table);
    let turns = 0;
    const streets = new Set();
    while (table.phase === "playing" && turns++ < 200) {
      streets.add(table.hand.street);
      tickPlaying(io, table, Number.MAX_SAFE_INTEGER);
    }
    assert.ok(turns < 200, "each hand must finish without a stuck actor");
    assert.equal(table.members.reduce((sum, member) => sum + member.point, 0), initialChips);
    assert.ok(table.members.every((member) => Number.isFinite(member.point) && member.point >= 0));
    const result = messages.find((message) => message.msgid === PUSH.DZPK_INNING_RESULT_PUSH);
    assert.ok(result, "normal settlement must be sent");
    assert.equal(result.payload.reduce((sum, player) => sum + player.score, 0), 0);
    assert.equal(table.history.length, 1);
    for (const street of Object.keys(reached)) if (streets.has(street)) reached[street] += 1;
    for (const message of messages) if (message.msgid === PUSH.DZPK_ACTION_BET_PUSH) {
      operations.add(message.payload.operation);
      for (const field of ["point", "currentBetScore", "totalBetScore", "pot"]) {
        if (message.payload[field] != null) assert.ok(Number.isFinite(message.payload[field]), field);
      }
    }
  }
  assert.ok(reached.BET_FLOP >= 30, "hands must not routinely end before the flop");
  assert.ok(reached.BET_TURN >= 15, "robots must continue beyond the second betting round");
  assert.ok(reached.BET_RIVER >= 8, "a meaningful sample must play the river");
  for (const op of [OP.ABANDON, OP.FOLLOW, OP.PASS, OP.ADD, OP.BET]) assert.ok(operations.has(op));
  t.diagnostic(JSON.stringify({ hands: 80, reached, operations: [...operations].sort((a, b) => a - b) }));
});

test("new engine versions load new robot functions without restarting", async () => {
  const first = await import("../../../../game-server/src/games/holdem/engine.js?v=robot-regression-1");
  const second = await import("../../../../game-server/src/games/holdem/engine.js?v=robot-regression-2");
  assert.notEqual(first.botChoose, second.botChoose);
  const { table, actor } = fixture();
  assert.deepEqual(first.botChoose(table, actor, () => 0.9), second.botChoose(table, actor, () => 0.9));
});
