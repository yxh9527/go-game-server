import assert from "node:assert/strict";
import test from "node:test";
import { SeatGame } from "../../../game-server/src/core/SeatGame.js";
import { beginHandStats, finishHandStats, observerList, ranking, pushRanking } from "../../../game-server/src/core/room-features.js";
import { HoldemGame } from "../../../game-server/src/games/holdem/HoldemGame.js";
import { createTexasTable, beginHand, onTexasAction } from "../../../game-server/src/games/holdem/engine.js";
import { OP } from "../../../game-server/src/games/holdem/op.js";
import { PUSH, SEND } from "../../../game-server/src/messages.js";

function fixture() {
  const game = new SeatGame({ id: "test", kind: "normal", roomTypes: [19], maxPeople: 7, minPeople: 2 });
  const table = game.createTable(700001, 19, {});
  const messages = [];
  const session = { userId: 42, name: "Alice", icon: 90024, wallet: 1000 };
  const ctx = { table, session, body: {}, send: (msgid, payload) => messages.push({ msgid, payload }),
    io: { broadcast: (msgid, payload) => messages.push({ msgid, payload }) } };
  return { game, table, messages, session, ctx };
}

test("new game inherits robot, ranking and observer integration with room-local history", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  // No game-specific ranking, observer, seat or robot lifecycle methods.
  class NewGame extends SeatGame {}
  const game = new NewGame({ id: "new-shared-game", kind: "normal", roomTypes: [987],
    maxPeople: 4, minPeople: 3, defaultCarryMin: 100,
    robotBehavior: { joinProbability: 1, leaveProbability: 0, minStayMs: 0,
      checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000, carryMaxMs: 1000 } });
  const table = game.createTable(9870000, 987, {});
  table.botTarget = 1;
  const messages = [];
  const session = { userId: 42, name: "Alice", icon: 90024, wallet: 1000 };
  const ctx = { table, session, body: {}, send(id, payload) { messages.push({ id, payload }); },
    io: { broadcast(id, payload) { messages.push({ id, payload }); } } };
  const latest = (id) => messages.findLast((message) => message.id === id).payload;
  game.onJoin(ctx);
  game.onJoin(ctx);
  assert.equal(latest(PUSH.DZPK_PUSH_WATCHGAME).length, 1);
  assert.equal(latest(PUSH.DZPK_PUSH_RANKINGLIST).userList.length, 0);
  game.tick(ctx);
  now += 1000; game.tick(ctx);
  now += 1000; game.tick(ctx);
  const bot = table.members[0];
  assert.equal(bot.bot, true);
  assert.equal(bot.point, 100);
  assert.equal(latest(PUSH.DZPK_PUSH_RANKINGLIST).userList[0].uid, bot.uid);
  assert.deepEqual(latest(PUSH.DZPK_PUSH_WATCHGAME).map((m) => m.uid), [42]);
  game.onSitDown(ctx);
  game.onCarryScore({ ...ctx, body: { carryIn: 5 } });
  const human = table.members.find((m) => m.uid === 42);
  assert.deepEqual(latest(PUSH.DZPK_PUSH_WATCHGAME), []);
  assert.equal(latest(PUSH.DZPK_PUSH_RANKINGLIST).totalTakeIn, 600);

  // A new engine supplies participation/results once to the common ledger.
  table.currentInning = 1;
  table.phase = "playing";
  table.hand = { pot: 50 };
  beginHandStats(table, [bot, human]);
  bot.point += 25; human.point -= 25;
  bot.totalBet = human.totalBet = 25;
  const results = [{ uid: bot.uid, score: 25, xiaZhuData: 25 }, { uid: 42, score: -25, xiaZhuData: 25 }];
  finishHandStats(table, results);
  finishHandStats(table, results);
  messages.length = 0;
  pushRanking(ctx);
  assert.deepEqual(messages.map((m) => m.id), [PUSH.DZPK_PUSH_RANKINGLIST]);
  assert.equal(messages[0].payload.totalHands, 1);
  assert.equal(messages[0].payload.totalStream, 50);
  assert.equal(messages[0].payload.userList[0].uid, bot.uid);
  table.phase = "idle"; table.hand = null;
  await game.afterRound(ctx);
  game.onStandUp(ctx);
  assert.equal(latest(PUSH.DZPK_PUSH_WATCHGAME)[0].winLostScore, -25);
  game.onLeave(ctx);
  table.cfg.robot_behavior = { joinProbability: 0, leaveProbability: 1 };
  game.tick(ctx);
  assert.equal(table.members.length, 0, "robot departures continue during the three-hand allowance");
  assert.equal(table.emptySinceHands, 1);
  assert.equal(table.suspendedAt, undefined);
  game.onJoin(ctx);
  game.tick(ctx);
  game.onLeave(ctx);
  assert.equal(table.members.length, 0);
  assert.deepEqual(latest(PUSH.DZPK_PUSH_WATCHGAME).map((m) => m.uid), [bot.uid]);
  const before = ranking(table);
  assert.equal(before.userList.length, 2);
  assert.equal(before.userList.reduce((sum, row) => sum + row.winLostScore, 0), 0);
  assert.equal(before.userList.reduce((sum, row) => sum + row.carryOutPoint, 0), 600);
  assert.ok(before.userList.every((row) => row.onTableFlag === 0 && row.totalHands === 1));

  const { SeatGame: Reloaded } = await import("../../../game-server/src/core/SeatGame.js?v=shared-capabilities-test");
  const updated = new Reloaded(game.config);
  const ledger = table.roomFeatures;
  messages.length = 0;
  assert.equal(updated.onMessage(ctx, SEND.DATA_REPORT, { buttonCode: "realtime_rank_main_btn" }), true);
  assert.deepEqual(messages.map((m) => m.id), [PUSH.DZPK_PUSH_RANKINGLIST, PUSH.DZPK_PUSH_WATCHGAME]);
  assert.deepEqual(messages[0].payload, before);
  assert.equal(table.roomFeatures, ledger);
  const other = updated.createTable(9870001, 987, {});
  updated.onJoin({ ...ctx, table: other });
  assert.notEqual(other.roomFeatures, ledger);
  assert.equal(ranking(other).userList.length, 0);
  assert.equal(observerList(other)[0].winLostScore, 0, "same uid must not inherit another room's losses");
  assert.equal(observerList(other)[0].userIcon, "/avator/90024.png");
  assert.deepEqual(ranking(table), before);
});

test("observer list publishes profile fields after join, sit, stand and leave", () => {
  const { game, table, messages, ctx } = fixture();
  const latest = () => messages.filter((message) => message.msgid === PUSH.DZPK_PUSH_WATCHGAME).at(-1).payload;
  game.onJoin(ctx);
  assert.equal(latest()[0].userName, "Alice");
  assert.equal(latest()[0].userIcon, "/avator/90024.png");
  game.onJoin(ctx);
  assert.equal(latest().length, 1);
  game.onSitDown(ctx);
  assert.deepEqual(latest(), []);
  game.onStandUp(ctx);
  assert.equal(latest().length, 1);
  game.onLeave(ctx);
  assert.deepEqual(latest(), []);
  assert.deepEqual(observerList(table), []);
});

test("ranking accounts for buy-ins, settlement, standing and repeat seating independently", () => {
  const { game, table, ctx } = fixture();
  game.onJoin(ctx);
  game.onSitDown(ctx);
  game.onCarryScore({ ...ctx, body: { carryIn: 5 } });
  const member = table.members[0];
  table.currentInning = 1;
  table.hand = { pot: 100 };
  beginHandStats(table, [member]);
  member.totalBet = 20;
  member.point = 580;
  const results = [{ uid: 42, score: 80, xiaZhuData: 20 }];
  finishHandStats(table, results);
  finishHandStats(table, results);
  table.hand = null;
  table.phase = "idle";
  game.onStandUp(ctx);
  let report = ranking(table);
  assert.equal(report.totalTakeIn, 500);
  assert.equal(report.totalHands, 1);
  assert.equal(report.totalStream, 20);
  assert.equal(report.averagePot, 100);
  assert.equal(report.userList[0].carryOutPoint, 580);
  assert.equal(report.userList[0].winLostScore, 80);
  assert.equal(report.userList[0].onTableFlag, 0);
  assert.equal(report.obMemberList[0].totalHands, 1);
  assert.equal(report.obMemberList[0].winLostScore, 80);
  game.onSitDown(ctx);
  game.onCarryScore({ ...ctx, body: { carryIn: 2 } });
  report = ranking(table);
  assert.equal(report.totalTakeIn, 700);
  assert.equal(report.userList[0].totalHands, 1);
  assert.equal(report.userList[0].winLostScore, 80);
  assert.equal(report.userList[0].onTableFlag, 1);
  assert.equal(report.currentActivePoint, 0);
  assert.equal(report.userList[0].point, 200);
  assert.equal(report.obMemberList.length, 0);
});

test("departed hand participants retain their committed loss and completed hand count", () => {
  const { table } = fixture();
  const a = { uid: 1, name: "a", point: 100, totalBet: 0 };
  const b = { uid: 2, name: "b", point: 100, totalBet: 0 };
  table.members = [a, b];
  table.currentInning = 1;
  table.hand = { pot: 60 };
  beginHandStats(table, [a, b]);
  a.totalBet = 20;
  b.totalBet = 40;
  table.members = [b];
  finishHandStats(table, [{ uid: 2, score: 20, xiaZhuData: 40 }]);
  const report = ranking(table);
  assert.equal(report.userList.find((row) => row.uid === 1).winLostScore, -20);
  assert.equal(report.userList.find((row) => row.uid === 1).totalHands, 1);
  assert.equal(report.totalStream, 60);
  assert.equal(report.userList.reduce((sum, row) => sum + row.winLostScore, 0), 0);
});

test("empty and live ranking requests always return all client numeric fields", () => {
  const { game, table, ctx, messages } = fixture();
  assert.equal(game.onMessage(ctx, SEND.SEND_GAME_RANKING_REQ, {}), true);
  const report = messages.find((message) => message.msgid === PUSH.DZPK_PUSH_RANKINGLIST).payload;
  assert.deepEqual(report.userList, []);
  for (const key of ["totalHands", "totalStream", "totalTakeIn", "currentActivePoint", "averagePot", "gameTime", "lastTime", "taxType", "taxPercent", "insuranceProfit"]) assert.ok(Number.isFinite(report[key]), key);
  table.members.push({ uid: 5, name: "robot", bot: true, point: 500 });
  assert.equal(ranking(table).totalTakeIn, 500);
  table.members[0].point = 300;
  assert.equal(ranking(table).totalTakeIn, 500);
});

test("statistics survive hot loading and message dependencies use the new version", async () => {
  const { table, game, ctx } = fixture();
  game.onSitDown(ctx);
  game.onCarryScore({ ...ctx, body: { carryIn: 5 } });
  const before = ranking(table, 100);
  for (const version of ["shared-feature-1", "shared-feature-2"]) {
    const features = await import("../../../game-server/src/core/room-features.js?v=" + version);
    const messages = await import("../../../game-server/src/messages.js?v=" + version);
    const originalId = messages.PUSH.DZPK_PUSH_RANKINGLIST;
    try {
      // Mimic a version with an updated constant while the old one is cached.
      messages.PUSH.DZPK_PUSH_RANKINGLIST = 50000;
      const emitted = [];
      features.handleRoomFeature({ ...ctx, send: (id) => emitted.push(id) }, SEND.SEND_GAME_RANKING_REQ);
      assert.equal(emitted[0], 50000);
      assert.deepEqual(features.ranking(table, 100), before);
    } finally {
      messages.PUSH.DZPK_PUSH_RANKINGLIST = originalId;
    }
  }
});

test("ranking counts down eight hours from creation regardless of older configuration", () => {
  const { table } = fixture();
  table.createdAt = 100000;
  table.cfg.game_time = 3600;
  assert.equal(ranking(table, 700000).gameTime, 28800);
  assert.equal(ranking(table, 700000).lastTime, 28200);
  assert.equal(ranking(table, 100000 + 28800000).lastTime, 0);
  delete table.cfg.game_time;
  assert.equal(ranking(table, 700000).gameTime, 28800);
  assert.equal(ranking(table, 700000).lastTime, 28200);
});

test("room ranking keeps all players through leaving, re-entry and hot reload for its entire lifetime", async () => {
  const game = new HoldemGame();
  const table = game.createTable(700003, 19, { small_blind: 10, big_blind: 20 });
  const ledger = table.roomFeatures;
  assert.ok(ledger.players instanceof Map, "ledger belongs to the room from creation");
  assert.equal(ledger.startedAt, table.createdAt);
  table.botTarget = 0;
  const io = { env: "dev", broadcast() {}, send() {}, forEachPlayer() {} };
  const a = { userId: 1, name: "Alice", wallet: 10000 };
  const b = { userId: 2, name: "Bob", wallet: 10000 };
  const context = (session) => ({ table, session, body: {}, send() {}, io });
  for (const session of [a, b]) {
    game.onJoin(context(session));
    game.onSitDown(context(session));
    game.onCarryScore({ ...context(session), body: { carryIn: 10 } });
  }
  const finishByFolding = () => {
    beginHand(io, table);
    assert.equal(table.phase, "playing");
    onTexasAction(io, table, { userId: table.hand.actorUid }, { operation: OP.ABANDON });
  };
  finishByFolding();
  const first = ranking(table);
  const firstScores = new Map(first.userList.map((row) => [row.uid, row.winLostScore]));
  assert.equal(first.totalHands, 1);
  for (const session of [a, b]) game.onLeave(context(session));
  assert.equal(table.members.length, 0);
  assert.equal(table.observers.length, 0);
  assert.equal(table.roomFeatures, ledger);

  const reloaded = await import("../../../game-server/src/core/room-features.js?v=whole-room-ledger-test");
  const afterLeave = reloaded.ranking(table, table.createdAt + 4 * 3600000);
  assert.equal(afterLeave.userList.length, 2, "empty room retains both players");
  assert.equal(afterLeave.lastTime, 14400);
  assert.equal(afterLeave.totalTakeIn, 2000);
  assert.equal(afterLeave.userList.reduce((sum, row) => sum + row.carryOutPoint, 0), 2000);
  assert.ok(afterLeave.userList.every((row) => row.totalHands === 1 && row.onTableFlag === 0));
  const watcher = { userId: 3, name: "Watcher", wallet: 1000 };
  game.onJoin(context(watcher));
  assert.equal(reloaded.ranking(table).userList.some((row) => row.uid === 3), false);
  assert.equal(reloaded.ranking(table).obMemberList[0].uid, 3);
  for (const session of [a, b]) {
    game.onJoin(context(session));
    game.onSitDown(context(session));
    game.onCarryScore({ ...context(session), body: { carryIn: 10 } });
  }
  finishByFolding();
  const report = reloaded.ranking(table, table.expiresAt);
  assert.equal(report.lastTime, 0);
  assert.equal(report.totalHands, 2);
  assert.equal(report.totalTakeIn, 4000);
  assert.equal(report.userList.length, 2, "re-entry accumulates into the existing uid");
  for (const row of report.userList) {
    assert.equal(row.totalHands, 2);
    const secondScore = table.history[1].firstGameList.find((player) => player.uid === row.uid).score;
    assert.equal(row.winLostScore, firstScores.get(row.uid) + secondScore);
    assert.equal(row.winLostScore, row.point + row.carryOutPoint - row.totalPoint);
  }
  assert.equal(table.roomFeatures, ledger);
  const another = createTexasTable(700004, 19, {});
  assert.notEqual(another.roomFeatures, ledger);
  assert.deepEqual(reloaded.ranking(another).userList, [], "new rooms have independent rankings");
});
