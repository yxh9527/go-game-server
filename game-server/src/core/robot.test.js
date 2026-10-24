import assert from "node:assert/strict";
import test from "node:test";
import { HoldemGame } from "../games/holdem/HoldemGame.js";
import { ZjhGame } from "../games/zjh/ZjhGame.js";
import * as robot from "./robot.js";
import { SeatGame } from "./SeatGame.js";
import { PUSH } from "../messages.js";
import { OP } from "../games/holdem/op.js";
import { ZJH_OP, ZJH_SEND } from "../games/zjh/messages.js";
import { SEND } from "../messages.js";
import { ROOM_LIFETIME_MS } from "./room-lifecycle.js";

for (const minimum of [2, 4]) {
  test("new " + minimum + "-player game inherits robot traffic without game-specific orchestration", async (t) => {
    let now = 1_800_000_000_000;
    t.mock.method(Date, "now", () => now);
    t.mock.method(Math, "random", () => 0.5);
    // Only gameplay hooks and configuration; no robot import, tick override,
    // custom buy-in, seating, departure or queue-start implementation.
    class NewGame extends SeatGame {
      startRound({ table }) {
        table.phase = "playing";
        table.currentInning++;
        table.hand = { players: this.seated(table).map((m) => m.uid) };
      }
    }
    const game = new NewGame({ id: "new-game", kind: "normal", roomTypes: [987], maxPeople: minimum + 1,
      minPeople: minimum, startDelayMs: 1000, defaultCarryMin: 250,
      robotBehavior: { joinProbability: 0, leaveProbability: 0, minStayMs: 0,
        checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000, carryMaxMs: 1000,
        cooldownMinMs: 3000, cooldownMaxMs: 3000 } });
    const table = game.createTable(9870000, 987, {});
    const human = { userId: 42, name: "observer", wallet: 10000 };
    const ctx = { table, session: human, send() {}, io: { broadcast() {} }, wallet: {
      debit() { assert.fail("robot must not debit human wallet"); },
      credit() { assert.fail("robot must not credit human wallet"); },
    } };
    assert.equal(table.carryMin, 250);
    assert.equal(game.defaultBuyIn(table), 250);
    game.onJoin(ctx);
    const step = (ms = 1000) => { now += ms; game.tick(ctx); };
    game.tick(ctx); step();
    assert.equal(table.members.length, 0, "game config can override shared defaults");
    table.cfg.robot_behavior = { joinProbability: 1 };
    step();
    assert.equal(table.members.length, 1, "room config overrides the game default");
    assert.equal(table.members[0].point, 0);
    assert.equal(table.members[0].carryDeadline, now + 12000);
    const uid = table.members[0].uid;
    step();
    assert.equal(table.members[0].point, 250);
    assert.equal(table.members[0].carryDeadline, undefined);
    assert.equal(table.phase, "idle", "unfunded seats must not meet the minimum players");
    for (let i = 0; i < minimum; i++) step();
    assert.equal(table.phase, "playing");
    assert.equal(table.hand.players.length, minimum);
    assert.equal(table.members.length, minimum, "one chair remains available for humans");
    assert.equal(human.wallet, 10000);
    assert.ok(table.observers.some((m) => m.uid === human.userId));
    table.hand = null;
    table.phase = "starting";
    table.roomFeatures.settledInning = table.currentInning;
    table.startAt = now + 6000;
    await game.afterRound(ctx);
    table.robotTraffic.nextCheckAt = now + 20000;
    table.cfg.robot_behavior.leaveProbability = 1;
    step(5999);
    assert.equal(table.members.length, minimum);
    step(1);
    assert.equal(table.members.length, 0, "shared scheduler handles departures before dealing again");
    assert.equal(table.phase, "idle");
    const profile = table.robotTraffic.profiles.get(uid);
    assert.equal(profile.session.wallet, 1250);
    assert.equal(profile.canSitAt, now + 3000);
    assert.equal(table.roomFeatures.players.get(uid).carryOutPoint, 250);
    table.cfg.robot_behavior.leaveProbability = 0;
    table.robotTraffic.nextCheckAt = now + 1000;
    step(3000);
    assert.equal(table.members[0].uid, uid, "same account reuses the common seat and carry flow");
    step();
    assert.equal(table.members[0].point, 250);
    assert.equal(profile.session.wallet, 1000);
    assert.equal(table.roomFeatures.players.get(uid).totalPoint, 500);
    assert.equal(table.expiresAt - table.createdAt, ROOM_LIFETIME_MS);
  });
}

function fixture(t, type = 19, overrides = {}) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(Math, "random", () => 0.5);
  const game = type === 25 ? new ZjhGame() : new HoldemGame();
  const table = game.createTable(700019, type, { carry_min: 500, robot_behavior: {
    checkMinMs: 1000, checkMaxMs: 1000, carryMinMs: 1000, carryMaxMs: 1000,
    cooldownMinMs: 3000, cooldownMaxMs: 3000, minStayMs: 0,
    joinProbability: 1, leaveProbability: 0, ...overrides,
  } });
  const messages = [];
  const blockedWallet = { debit() { assert.fail("robot used human debit"); },
    credit() { assert.fail("robot used human credit"); }, persist() { assert.fail("robot used human persistence"); } };
  const ctx = { table, wallet: blockedWallet, runtime: { env: "dev", wallet: blockedWallet },
    io: { env: "dev", broadcast(id, data) { messages.push({ id, data }); }, send() {}, forEachPlayer() {} }, send() {} };
  const traffic = (ms = 0, rng = () => 0.5) => { now += ms; robot.tickRoom(game, ctx, now, rng); };
  const step = async (ms = 1000) => { now += ms; game.tick(ctx); await game.afterRound(ctx); };
  const funds = () => [...(table.robotTraffic?.profiles.values() || [])].reduce((sum, p) => sum + p.session.wallet, 0)
    + table.members.filter((m) => m.bot).reduce((sum, m) => sum + m.point, 0)
    + (table.phase === "playing" ? table.hand.pot : 0);
  return { game, robot, table, ctx, messages, traffic, step, funds, now: () => now,
    advance(ms) { now += ms; } };
}

for (const type of [19, 25]) {
  test(type + ": probabilistic arrivals occupy one seat, then carry through the common flow", (t) => {
    const f = fixture(t, type, { joinProbability: 0 });
    f.traffic();
    f.traffic(1000);
    assert.equal(f.table.members.length, 0);
    f.table.cfg.robot_behavior.joinProbability = 0.6;
    f.traffic(1000, () => 0.9);
    assert.equal(f.table.members.length, 0, "failed probability roll must leave a vacancy");
    f.traffic(1000, () => 0.1);
    assert.equal(f.table.members.length, 1);
    const member = f.table.members[0];
    const profile = f.table.robotTraffic.profiles.get(member.uid);
    const total = f.funds();
    assert.equal(member.point, 0);
    assert.equal(member.carryDeadline, f.now() + 12000);
    assert.equal(f.messages.find((m) => m.id === PUSH.JOIN_ROOM).data.userInfo.uid, member.uid);
    for (let i = 0; i < 20; i++) f.traffic();
    assert.equal(f.table.members.length, 1, "extra ticks must not reroll arrivals");
    f.table.cfg.robot_behavior.joinProbability = 0;
    f.traffic(999);
    assert.equal(member.point, 0);
    f.traffic(1);
    assert.ok(member.point >= f.table.carryMin);
    assert.equal(member.carryDeadline, undefined);
    assert.equal(profile.session.wallet + member.point, total);
    assert.equal(f.table.roomFeatures.players.get(member.uid).totalPoint, member.point);
    assert.equal(f.messages.some((m) => [PUSH.ROOM_INFO, PUSH.CARRYIN_RESULT].includes(m.id)), false);
    const lastRank = f.messages.findLastIndex((m) => m.id === PUSH.DZPK_PUSH_RANKINGLIST);
    assert.equal(f.messages[lastRank + 1].id, PUSH.DZPK_PUSH_WATCHGAME);
  });

  test(type + ": completed hand gets one departure decision even before periodic timer", async (t) => {
    const f = fixture(t, type);
    if (type === 25) f.table.carryMin = 100;
    f.traffic(); f.traffic(1000); f.traffic(1000); f.traffic(1000);
    f.table.cfg.robot_behavior.joinProbability = 0;
    f.traffic(1000);
    f.table.cfg.robot_behavior.leaveProbability = 1;
    const total = f.funds();
    f.game.startRound(f.ctx);
    const hand = f.table.hand;
    f.traffic(1000);
    assert.equal(f.table.hand, hand);
    assert.equal(f.table.members.length, 3, "no departures during active hand");
    assert.equal(f.funds(), total);
    for (let turns = 0; f.table.hand && turns < 10; turns++) {
      const uid = f.table.hand.actorUid;
      f.game.onMessage({ ...f.ctx, session: { userId: uid } },
        type === 19 ? SEND.DZPK_SEND_ACTION : ZJH_SEND.ACTION,
        { uid, operation: type === 19 ? OP.ABANDON : ZJH_OP.FOLD, operationData: 0 });
    }
    assert.equal(f.table.hand, null, "normal fold actions must settle the hand");
    await f.game.afterRound(f.ctx);
    f.table.robotTraffic.nextCheckAt = f.table.startAt + 50000;
    f.traffic(f.table.startAt - f.now() - 1);
    assert.equal(f.table.members.length, 3, "settlement animation must finish first");
    f.traffic(1);
    assert.equal(f.table.members.length, 0);
    assert.equal(f.table.observers.length, 3);
    assert.equal(f.funds(), total);
    assert.equal(f.messages.filter((m) => m.id === PUSH.USER_STANDUP_ROOM).length, 3);
    assert.equal(f.messages.some((m) => m.id === PUSH.ROOM_INFO), false);
    assert.equal(f.table.expiresAt - f.table.createdAt, ROOM_LIFETIME_MS);
  });

  test(type + ": one completed hand cannot repeatedly roll for departure", (t) => {
    const f = fixture(t, type);
    f.table.botTarget = 1;
    f.traffic(); f.traffic(1000); f.traffic(1000);
    f.table.cfg.robot_behavior.joinProbability = 0;
    f.table.currentInning = 1;
    f.table.startAt = f.now();
    f.table.robotTraffic.nextCheckAt = f.now() + 10000;
    f.traffic();
    assert.equal(f.table.members.length, 1, "zero departure probability must keep the seat");
    f.table.cfg.robot_behavior.leaveProbability = 1;
    f.traffic(); f.traffic(9999);
    assert.equal(f.table.members.length, 1, "completed-hand decision must be recorded even when staying");
    f.traffic(1);
    assert.equal(f.table.members.length, 0);
  });

  test(type + ": cooldown reuses the same robot wallet and retains carry history", (t) => {
    const f = fixture(t, type);
    f.table.botTarget = 1;
    f.traffic(); f.traffic(1000); f.traffic(1000);
    const member = f.table.members[0];
    const uid = member.uid;
    const opening = member.point;
    const profile = f.table.robotTraffic.profiles.get(uid);
    const total = f.funds();
    f.table.cfg.robot_behavior.leaveProbability = 1;
    f.table.cfg.robot_behavior.joinProbability = 0;
    f.traffic(1000);
    assert.equal(f.table.members.length, 0);
    assert.equal(profile.session.wallet, total);
    f.traffic(2000);
    assert.equal(f.table.members.length, 0);
    f.table.cfg.robot_behavior.leaveProbability = 0;
    f.table.cfg.robot_behavior.joinProbability = 1;
    f.traffic(1000);
    assert.equal(f.table.members[0].uid, uid);
    assert.equal(f.table.members[0].point, 0);
    f.traffic(1000);
    assert.equal(f.funds(), total);
    assert.equal(profile.session.wallet, total - opening);
    assert.equal(f.table.roomFeatures.players.get(uid).totalPoint, opening * 2);
    assert.equal(f.table.roomFeatures.players.get(uid).carryOutPoint, opening);
  });

  test(type + ": robot buy-in timeout cannot immediately reseat or charge", (t) => {
    const f = fixture(t, type);
    f.table.botTarget = 1;
    f.traffic(); f.traffic(1000);
    const uid = f.table.members[0].uid;
    const profile = f.table.robotTraffic.profiles.get(uid);
    const total = f.funds();
    f.traffic(12000);
    assert.equal(f.table.members.some((m) => m.uid === uid), false);
    assert.equal(profile.canSitAt, f.now() + 3000);
    assert.equal(profile.session.wallet, total);
    assert.equal(f.messages.some((m) => m.id === PUSH.CARRY_SCORE_RESULT), false);
  });

  test(type + ": low-chip post-hand stand credits the robot reserve exactly once", async (t) => {
    const f = fixture(t, type);
    f.table.botTarget = 1;
    f.traffic(); f.traffic(1000); f.traffic(1000);
    const member = f.table.members[0];
    const profile = f.table.robotTraffic.profiles.get(member.uid);
    member.point = 499;
    f.table.roomFeatures.settledInning = 1;
    f.table.currentInning = 1;
    const total = f.funds();
    await f.game.afterRound(f.ctx);
    await f.game.afterRound(f.ctx);
    assert.equal(f.table.members.length, 0);
    assert.equal(profile.session.wallet, total);
    f.traffic();
    assert.equal(profile.canSitAt, f.now() + 3000);
    f.traffic(3000);
    assert.equal(f.table.members[0].uid, member.uid);
    f.traffic(1000);
    assert.equal(f.funds(), total);
  });

  test(type + ": empty active room resumes robot games without any human", async (t) => {
    const f = fixture(t, type, { leaveProbability: 1 });
    f.traffic();
    f.table.cfg.robot_behavior.leaveProbability = 0;
    for (let i = 0; i < 6; i++) await f.step();
    assert.equal(f.table.phase, "playing");
    assert.ok(f.table.members.every((m) => m.bot));
    assert.ok(f.table.hand.actorUid > 0);
    assert.ok(f.table.members.filter((m) => m.hole?.length).every((m) => m.carryDeadline == null));
    assert.ok(f.table.members.length <= f.game.maxPeople() - 1);
  });

  test(type + ": arrivals during a hand wait until the next deal and reserve a human chair", (t) => {
    const f = fixture(t, type);
    f.traffic(); f.traffic(1000); f.traffic(1000);
    f.table.botTarget = 2;
    f.traffic(1000);
    f.game.startRound(f.ctx);
    const hand = f.table.hand;
    const players = hand.statsPlayers.map((m) => m.uid);
    const pot = hand.pot;
    f.table.botTarget = f.game.maxPeople();
    f.traffic(1000); f.traffic(1000);
    const newcomer = f.table.members.find((m) => !players.includes(m.uid) && m.point > 0);
    assert.ok(newcomer);
    assert.equal(newcomer.hole, undefined);
    assert.deepEqual(hand.statsPlayers.map((m) => m.uid), players);
    assert.equal(hand.pot, pot);
    assert.equal(f.table.hand, hand);
    for (let i = 0; i < 10; i++) f.traffic(1000);
    assert.equal(f.table.members.length, f.game.maxPeople() - 1);
    const session = { userId: 42, name: "human", wallet: 10000 };
    f.game.watch(f.table, session);
    f.traffic(1000);
    assert.equal(f.table.members.some((m) => m.uid === 42), false);
    assert.equal(session.wallet, 10000);
    f.game.onSitDown({ ...f.ctx, session, body: { position: f.game.nextSeat(f.table) } });
    assert.equal(f.table.members.length, f.game.maxPeople());
    assert.equal(f.table.members.find((m) => m.uid === 42).point, 0);
    assert.equal(session.wallet, 10000);
  });

  test(type + ": multiple autonomous hands include arrivals, departures and conserved bankrolls", async (t) => {
    const f = fixture(t, type, { joinProbability: 0.7, leaveProbability: 0.45, minStayMs: 10000,
      checkMinMs: 2000, checkMaxMs: 4000, observerLifetimeMs: 3600000 });
    if (type === 25) f.table.carryMin = 100;
    let seed = 20261024;
    t.mock.method(Math, "random", () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
    const bankrolls = new Map();
    let liveHandArrival = false;
    f.game.tick(f.ctx);
    for (let seconds = 0; seconds < 360; seconds++) {
      const beforeHand = f.table.hand;
      const beforeSeats = new Set(f.table.members.map((m) => m.uid));
      await f.step();
      for (const [uid, p] of f.table.robotTraffic.profiles) {
        if (!bankrolls.has(uid)) bankrolls.set(uid, p.session.wallet);
      }
      if (beforeHand && beforeHand === f.table.hand && f.table.members.some((m) => !beforeSeats.has(m.uid))) liveHandArrival = true;
      assert.equal(f.funds(), [...bankrolls.values()].reduce((sum, n) => sum + n, 0));
      assert.equal(new Set(f.table.members.map((m) => m.pos)).size, f.table.members.length);
      assert.ok(f.table.members.length < f.game.maxPeople());
    }
    assert.ok(f.table.roomFeatures.totalHands >= 5, "autonomous tables must keep completing hands");
    assert.ok(f.messages.some((m) => m.id === PUSH.USER_STANDUP_ROOM), "robots must actually leave seats");
    assert.ok(liveHandArrival, "vacancies can be filled without disturbing an active hand");
    assert.equal(f.messages.some((m) => m.id === PUSH.ROOM_INFO), false);
    assert.equal(f.table.expiresAt - f.table.createdAt, ROOM_LIFETIME_MS);
  });
}

test("room guards stop traffic for reserves, tournaments, admission and expiry", (t) => {
  const f = fixture(t);
  const variants = [
    { standby: true }, { roomType: 101 }, { admissionTask: Promise.resolve() },
    { roundAdmission: {} }, { closing: true }, { createdAt: f.now() - ROOM_LIFETIME_MS },
  ];
  for (const changes of variants) {
    const table = Object.assign(f.game.createTable(700010, 19, {}), changes);
    const ctx = { ...f.ctx, table };
    f.robot.tickRoom(f.game, ctx, f.now());
    f.robot.tickRoom(f.game, ctx, f.now() + 60000);
    assert.equal(table.robotTraffic, undefined);
    assert.equal(table.members.length, 0);
  }
});

test("hot update retains arrival timers, bankroll, minimum stay and cooldown", async (t) => {
  const f = fixture(t, 19, { minStayMs: 5000 });
  f.table.botTarget = 1;
  f.traffic(); f.traffic(1000); f.traffic(1000);
  const state = f.table.robotTraffic;
  const profile = [...state.profiles.values()][0];
  const total = f.funds();
  const { HoldemGame: Reloaded } = await import("../games/holdem/HoldemGame.js?v=traffic-reload");
  const reloaded = new Reloaded();
  f.table.cfg.robot_behavior.joinProbability = 0;
  f.table.cfg.robot_behavior.leaveProbability = 1;
  reloaded.tick(f.ctx);
  assert.equal(f.table.robotTraffic, state);
  assert.equal(f.table.members.length, 1);
  f.advance(3000); reloaded.tick(f.ctx);
  assert.equal(f.table.members.length, 1);
  f.advance(1000); reloaded.tick(f.ctx);
  assert.equal(f.table.members.length, 0);
  assert.equal(profile.session.wallet, total);
  const until = profile.canSitAt;
  reloaded.tick(f.ctx);
  assert.equal(profile.canSitAt, until);
  assert.equal(f.table.createdAt, 1_800_000_000_000);
});

test("observer retirement releases profiles without reusing ranking identities", (t) => {
  const f = fixture(t, 19, { observerLifetimeMs: 2000 });
  f.table.botTarget = 1;
  f.traffic(); f.traffic(1000); f.traffic(1000);
  const uid = f.table.members[0].uid;
  f.table.cfg.robot_behavior.leaveProbability = 1;
  f.table.cfg.robot_behavior.joinProbability = 0;
  f.traffic(1000); f.traffic(2000);
  assert.equal(f.table.robotTraffic.profiles.size, 0);
  assert.equal(f.table.observers.length, 0);
  assert.ok(f.table.roomFeatures.players.has(uid));
  assert.equal(f.messages.find((m) => m.id === PUSH.USER_LEVEL_ROOM).data.uid, uid);
  f.table.robotTraffic.nextUid = uid;
  f.table.cfg.robot_behavior.joinProbability = 1;
  f.traffic(1000);
  assert.notEqual(f.table.members[0].uid, uid);
});

test("legacy bots keep their chips across hot adoption without minting reserve funds", (t) => {
  const f = fixture(t, 19, { joinProbability: 0 });
  f.table.members.push({ uid: 90000001, pos: 0, point: 777, bot: true, name: "existing" });
  f.traffic();
  const profile = f.table.robotTraffic.profiles.get(90000001);
  assert.equal(profile.session.wallet, 0);
  assert.equal(f.table.members[0].point, 777);
  f.table.cfg.robot_behavior.leaveProbability = 1;
  f.traffic(1000);
  assert.equal(profile.session.wallet, 777);
  assert.equal(f.table.members.length, 0);
});
