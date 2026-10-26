import assert from "node:assert/strict";
import test from "node:test";
import { botChoose, scheduleTurn, tickBot } from "../../../../game-server/src/games/zjh/robot.js";
import { ZJH_OP, ZJH_PUSH } from "../../../../game-server/src/games/zjh/messages.js";
import { beginHand, tickPlaying } from "../../../../game-server/src/games/zjh/engine.js";
import { ZjhGame } from "../../../../game-server/src/games/zjh/ZjhGame.js";

function fixture(hole = [0, 13, 26]) {
  const actor = { uid: 90000002, hole, looked: true, bot: true, point: 1000, streetBet: 0, totalBet: 10 };
  const rival = { uid: 2, totalBet: 100, streetBet: 100, point: 1000 };
  return { actor, rival, table: { ante: 10, members: [actor, rival], hand: { currentBet: 100, pot: 110, round: 2 } } };
}

test("zjh strong cards survive second round and bets above eight antes", () => {
  const { table, actor } = fixture();
  assert.notEqual(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
  assert.equal(botChoose(table, actor, () => 0.1).operation, ZJH_OP.RAISE);
});

test("zjh weak hands fold to expensive calls", () => {
  const { table, actor } = fixture([1, 17, 32]);
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
});

test("zjh blind decisions do not read even their own unrevealed cards", () => {
  const { table, actor, rival } = fixture();
  actor.looked = false;
  Object.defineProperty(actor, "hole", { get() { throw new Error("unseen own cards accessed"); } });
  Object.defineProperty(rival, "hole", { get() { throw new Error("rival cards accessed"); } });
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.LOOK);
  table.hand.round = 1;
  table.hand.currentBet = 10;
  assert.equal(botChoose(table, actor, () => 0.1).operation, ZJH_OP.CALL);
});

test("zjh comparisons select a live public opponent without reading its cards", () => {
  const { table, actor, rival } = fixture();
  table.hand.round = 3;
  Object.defineProperty(rival, "hole", { get() { throw new Error("rival cards accessed"); } });
  assert.deepEqual(botChoose(table, actor, () => 0.1), { operation: ZJH_OP.COMPARE, targetUid: rival.uid });
});

test("zjh action scheduling respects deadlines", () => {
  const { table, actor } = fixture();
  table.hand = { currentBet: 10, botActAt: 0, deadline: 1200 };
  scheduleTurn(table, actor, 1000, () => 0.9);
  assert.ok(table.hand.botActAt <= 1100);
  const calls = [];
  tickBot(table, actor, 1000, (...args) => calls.push(args));
  assert.equal(calls.length, 0);
  tickBot(table, actor, 1100, (...args) => calls.push(args));
  assert.equal(calls.length, 1);
});

test("zjh entry and robot strategy participate in versioned hot loading", async () => {
  const first = await import("../../../../game-server/src/games/zjh/index.js?v=robot-regression-1");
  const second = await import("../../../../game-server/src/games/zjh/index.js?v=robot-regression-2");
  assert.notEqual(first.default.constructor, second.default.constructor);
  const a = await import("../../../../game-server/src/games/zjh/engine.js?v=robot-regression-1");
  const b = await import("../../../../game-server/src/games/zjh/engine.js?v=robot-regression-2");
  assert.notEqual(a.botChoose, b.botChoose);
});

test("zjh robot games terminate with normal settlement and conserved chips", (t) => {
  let seed = 20261023;
  t.mock.method(Math, "random", () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
  const game = new ZjhGame();
  let reachedThirdRound = 0;
  const actions = new Set();
  for (let hand = 0; hand < 80; hand += 1) {
    const table = game.createTable(790000 + hand, 25, { ante: 10, carry_min: 100 });
    table.members = Array.from({ length: 2 + hand % 4 }, (_, pos) => ({
      uid: 90000002 + pos, name: "bot" + pos, pos, point: 1000, bot: true,
    }));
    const initialChips = table.members.reduce((sum, member) => sum + member.point, 0);
    const messages = [];
    const io = { send() {}, forEachPlayer() {}, broadcast(msgid, payload) { messages.push({ msgid, payload }); } };
    beginHand(io, table);
    let turns = 0;
    while (table.phase === "playing" && turns++ < 200) tickPlaying(io, table, Number.MAX_SAFE_INTEGER);
    assert.ok(turns < 200, "robot must finish its actions");
    assert.equal(table.members.reduce((sum, member) => sum + member.point, 0), initialChips);
    assert.ok(table.members.every((member) => Number.isFinite(member.point) && member.point >= 0));
    const result = messages.find((message) => message.msgid === ZJH_PUSH.INNING_RESULT);
    assert.ok(result);
    assert.equal(result.payload.reduce((sum, member) => sum + member.score, 0), 0);
    if (messages.some((m) => m.msgid === ZJH_PUSH.ROUND_INFO && m.payload >= 3)) reachedThirdRound += 1;
    for (const m of messages) if (m.msgid === ZJH_PUSH.ACTION_BET) actions.add(m.payload.operation);
  }
  assert.ok(reachedThirdRound > 30, "normal games must continue beyond the second round");
  for (const op of [ZJH_OP.CALL, ZJH_OP.RAISE, ZJH_OP.LOOK, ZJH_OP.COMPARE, ZJH_OP.FOLD]) assert.ok(actions.has(op));
  t.diagnostic("80 robot hands, " + reachedThirdRound + " reached round 3; action variety and chip conservation verified");
});
