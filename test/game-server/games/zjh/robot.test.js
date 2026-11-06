import assert from "node:assert/strict";
import test from "node:test";
import { botChoose, scheduleTurn, tickBot } from "../../../../game-server/src/games/zjh/robot.js";
import { ZJH_OP, ZJH_PUSH } from "../../../../game-server/src/games/zjh/messages.js";
import { actionOptions, beginHand, onZjhAction, tickPlaying } from "../../../../game-server/src/games/zjh/engine.js";
import { ZjhGame } from "../../../../game-server/src/games/zjh/ZjhGame.js";

function fixture(hole = [0, 13, 26]) {
  const actor = { uid: 90000002, hole, looked: true, bot: true, point: 1000, streetBet: 0, totalBet: 10 };
  const rival = { uid: 2, totalBet: 100, streetBet: 100, point: 1000 };
  return { actor, rival, table: { ante: 10, members: [actor, rival], hand: { currentBet: 100, pot: 110, round: 2 } } };
}

function ioFor(messages = []) {
  return { send() {}, forEachPlayer() {}, broadcast(msgid, payload) { messages.push({ msgid, payload }); } };
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

test("known human cards change the same pair from a fold to value betting", () => {
  const { table, actor, rival } = fixture([12, 25, 7]); // KK8
  rival.hole = [0, 13, 6]; // AA7
  assert.equal(botChoose(table, actor, () => 0.1).operation, ZJH_OP.FOLD);
  rival.hole = [11, 24, 19]; // QQ7; same hand object must invalidate its estimate.
  assert.equal(botChoose(table, actor, () => 0.1).operation, ZJH_OP.RAISE);
  assert.equal(botChoose(table, actor, () => 0.99).operation, ZJH_OP.CALL);
  rival.hole = [0, 13, 6];
  actor.point = 50;
  assert.equal(botChoose(table, actor, () => 0.1).operation, ZJH_OP.FOLD);
});

test("human comparisons follow the engine's suit tiebreak and low A23 straight", () => {
  const { table, actor, rival } = fixture([12, 25, 7]);
  rival.hole = [38, 51, 20];
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
  actor.hole = [38, 51, 7];
  rival.hole = [12, 25, 20];
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.CALL);
  actor.hole = [0, 14, 28]; // A23, the lowest straight.
  rival.hole = [2, 16, 30]; // 345
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
});

test("comparisons remove the strongest beatable human instead of a random target", () => {
  const { table, actor, rival } = fixture(); // AAA
  rival.hole = [4, 18, 32]; // 567 straight
  const stronger = { uid: 3, hole: [12, 25, 38], totalBet: 100, point: 1000, looked: true };
  table.hand.participants = [actor, rival, stronger];
  table.hand.round = 3;
  assert.deepEqual(botChoose(table, actor, () => 0.1), { operation: ZJH_OP.COMPARE, targetUid: stronger.uid });
  stronger.folded = true;
  assert.deepEqual(botChoose(table, actor, () => 0.1), { operation: ZJH_OP.COMPARE, targetUid: rival.uid });
});

test("known side-pot winnings are not discarded because a short all-in has a better hand", () => {
  const { table, actor, rival } = fixture([11, 24, 37]); // QQQ
  actor.totalBet = 100;
  rival.hole = [12, 25, 7]; // KK8
  const short = { uid: 3, hole: [0, 13, 26], totalBet: 10, point: 0 };
  table.hand.participants = [actor, rival, short];
  table.hand.currentBet = 10;
  table.hand.pot = 210;
  assert.equal(botChoose(table, actor, () => 0.99).operation, ZJH_OP.CALL);
});

test("blind robots use human cards without reading their own hidden hand or the deck", () => {
  const { table, actor, rival } = fixture();
  const forbidden = { get() { throw new Error("hidden information accessed"); } };
  actor.looked = false;
  Object.defineProperty(actor, "hole", forbidden);
  Object.defineProperty(table.hand, "deck", forbidden);
  Object.defineProperty(table.hand, "deckPos", forbidden);
  rival.hole = [12, 25, 38]; // KKK is extremely unlikely to be beaten by an unknown hand.
  table.hand.round = 1;
  table.hand.currentBet = 10;
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
  table.hand.round = 2;
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.LOOK);
  rival.hole = [1, 17, 32];
  table.hand.round = 1;
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.CALL);
});

test("partial-open robots only read the initially visible one or two own cards", () => {
  for (const mode of [2, 5]) {
    const { table, actor, rival } = fixture();
    table.playMode = mode;
    actor.looked = false;
    const count = mode === 2 ? 2 : 1;
    const cards = [0, 13, 26];
    for (let i = count; i < 3; i += 1) Object.defineProperty(cards, i,
      { get() { throw new Error("unseen partial hand accessed"); } });
    actor.hole = cards;
    rival.hole = [12, 25, 38];
    assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.LOOK);
  }
});

test("unknown bot, folded and newly seated cards never enter the human-card policy", () => {
  const { table, actor, rival } = fixture();
  const forbidden = { get() { throw new Error("excluded cards accessed"); } };
  rival.bot = true;
  Object.defineProperty(rival, "hole", forbidden);
  const folded = { uid: 3, totalBet: 100, point: 1000, folded: true };
  const joined = { uid: 4, totalBet: 0, point: 1000 };
  Object.defineProperty(folded, "hole", forbidden);
  Object.defineProperty(joined, "hole", forbidden);
  table.hand.participants = [actor, rival, folded];
  table.members.push(folded, joined);
  assert.notEqual(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
});

test("weak seen human hands permit occasional affordable bluffs", () => {
  const { table, actor, rival } = fixture([10, 19, 28]); // J73
  rival.hole = [11, 18, 30]; // Q65
  rival.looked = true;
  table.hand.currentBet = 10;
  table.hand.acted = new Set([rival.uid]);
  assert.equal(botChoose(table, actor, () => 0).operation, ZJH_OP.RAISE);
  assert.equal(botChoose(table, actor, () => 0.9).operation, ZJH_OP.FOLD);
  actor.point = 50;
  assert.equal(botChoose(table, actor, () => 0).operation, ZJH_OP.FOLD);
});

test("zjh blind decisions do not read even their own unrevealed cards", () => {
  const { table, actor, rival } = fixture();
  actor.looked = false;
  rival.bot = true;
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
  rival.bot = true;
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

test("chosen look, raise and comparison actions use the normal legal options and chip units", () => {
  const game = new ZjhGame();
  for (const operation of [ZJH_OP.LOOK, ZJH_OP.RAISE, ZJH_OP.COMPARE]) {
    const table = game.createTable(795000 + operation, 25, { ante: 10, carry_min: 100 });
    table.members = [0, 1].map((pos) => ({ uid: 90000002 + pos, pos, point: 1000, bot: true }));
    const io = ioFor();
    beginHand(io, table);
    const actor = table.members.find((member) => member.uid === table.hand.actorUid);
    const rival = table.members.find((member) => member !== actor);
    actor.hole = [0, 13, 26];
    rival.hole = [12, 25, 38];
    rival.bot = false;
    actor.looked = operation !== ZJH_OP.LOOK;
    table.hand.round = operation === ZJH_OP.COMPARE ? 3 : 2;
    const choice = botChoose(table, actor, () => operation === ZJH_OP.LOOK ? 0.99 : 0.1);
    assert.equal(choice.operation, operation);
    const option = actionOptions(table, actor).find((item) => item.operation === operation);
    assert.equal(option.data.isEnable, true);
    const before = { point: actor.point, bet: actor.totalBet, pot: table.hand.pot };
    assert.equal(onZjhAction(io, table, { userId: actor.uid }, { uid: actor.uid, ...choice }), true);
    assert.equal(actor.point, before.point - option.data.score);
    assert.equal(actor.totalBet, before.bet + option.data.score);
    assert.equal(table.hand.pot, before.pot + option.data.score);
    if (operation === ZJH_OP.COMPARE) {
      assert.equal(rival.folded, true);
      assert.ok(table.hand.comparisonPause);
      tickPlaying(io, table, Number.MAX_SAFE_INTEGER);
      assert.equal(table.hand, null);
      assert.equal(table.members.reduce((sum, member) => sum + member.point, 0), 2000);
    }
  }
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

test("mixed human and bot games settle in normal, look-one and look-two modes", (t) => {
  let seed = 20261106;
  t.mock.method(Math, "random", () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
  const game = new ZjhGame();
  let humanWins = 0, botWins = 0;
  for (let index = 0; index < 60; index += 1) {
    const table = game.createTable(796000 + index, 25,
      { ante: 10, carry_min: 100, play_mode: [3, 2, 5][index % 3], force_show_card: 0 });
    table.members = Array.from({ length: 2 + index % 6 }, (_, pos) => ({
      uid: 90000002 + pos, name: "player" + pos, pos, point: 300 + pos * 130,
      bot: pos > (index % 2 && index % 6 > 0 ? 1 : 0),
    }));
    const initial = table.members.reduce((sum, member) => sum + member.point, 0);
    const messages = [];
    const io = ioFor(messages);
    beginHand(io, table);
    let turns = 0;
    while (table.phase === "playing" && turns++ < 200) {
      if (table.hand.comparisonPause) {
        tickPlaying(io, table, Number.MAX_SAFE_INTEGER);
        continue;
      }
      const actor = table.members.find((member) => member.uid === table.hand.actorUid);
      assert.ok(actor);
      if (actor.bot) {
        const choice = botChoose(table, actor);
        assert.ok(actionOptions(table, actor).some((option) => option.operation === choice.operation && option.data.isEnable));
        assert.equal(onZjhAction(io, table, { userId: actor.uid }, { uid: actor.uid, ...choice }), true);
      } else {
        const operation = !actor.looked && table.hand.round > 1 ? ZJH_OP.LOOK
          : actor.point < table.hand.currentBet * (actor.looked ? 2 : 1) ? ZJH_OP.ALL_IN : ZJH_OP.CALL;
        assert.equal(onZjhAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation }), true);
      }
    }
    assert.ok(turns < 200, "mixed game must settle without rejected or stuck actions");
    assert.equal(table.members.reduce((sum, member) => sum + member.point, 0), initial);
    assert.ok(table.members.every((member) => Number.isFinite(member.point) && member.point >= 0));
    const result = messages.find((message) => message.msgid === ZJH_PUSH.INNING_RESULT);
    assert.ok(result);
    assert.equal(result.payload.reduce((sum, member) => sum + member.score, 0), 0);
    const winner = result.payload.find((player) => player.score > 0);
    if (winner) {
      if (table.members.find((member) => member.uid === winner.uid).bot) botWins += 1;
      else humanWins += 1;
    }
  }
  assert.ok(humanWins > 0 && botWins > 0, "card information must not force either side to win every hand");
  t.diagnostic(JSON.stringify({ hands: 60, humanWins, botWins }));
});
