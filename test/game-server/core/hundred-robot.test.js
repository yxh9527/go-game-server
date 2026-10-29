import assert from 'node:assert/strict';
import test from 'node:test';
import { HundredGame } from '../../../game-server/src/core/HundredGame.js';
import { HundredHoldemGame } from '../../../game-server/src/games/hundred-holdem/HundredHoldemGame.js';
import { BaccaratGame } from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import * as holdem from '../../../game-server/src/games/hundred-holdem/engine.js';
import * as baccarat from '../../../game-server/src/games/baccarat/engine.js';
import { chooseHundredBet } from '../../../game-server/src/core/robot.js';
import { PUSH } from '../../../game-server/src/messages.js';
import { seedRooms } from '../../../cache/rpc/seed.js';

const policy = { initialRobots: 2, targetRobots: 2, maxRobots: 2,
  joinProbability: 0, leaveProbability: 0, participationProbability: 1,
  checkMinMs: 1000, checkMaxMs: 1000, betMinMs: 1000, betMaxMs: 1000,
  cooldownMinMs: 3000, cooldownMaxMs: 3000, minStayMs: 0, maxBetsPerRound: 1 };

function fixture(t, game = new HundredHoldemGame(), mode = 1) {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(Math, 'random', () => 0);
  const row = seedRooms().find(row => row.room_type === game.roomTypes[0]
    && (game.id !== 'hundred-holdem' || row.play_mode === mode)) || {};
  const table = game.createTable(700500 + mode, game.roomTypes[0], { ...row, robot_behavior: { ...policy } });
  const human = { userId: 42, wallet: 1000000 };
  const messages = [];
  let present = true;
  const wallet = {
    debit(session, amount) { assert.equal(session.bot, undefined, 'robot cannot debit the RPC wallet'); session.wallet -= amount; return { ok: true }; },
    credit(session, amount) { assert.equal(session.bot, undefined, 'robot cannot credit the RPC wallet'); session.wallet += amount; return { ok: true }; },
  };
  const io = { wallet, broadcast(id, data) { messages.push({ uid: 0, id, data: structuredClone(data) }); },
    sendUser(uid, id, data) { messages.push({ uid, id, data: structuredClone(data) }); },
    forEachPlayer(fn) { if (present) fn(human); } };
  const ctx = { table, session: human, io, wallet, send(id, data) { messages.push({ uid: 42, id, data: structuredClone(data) }); } };
  return { game, table, human, io, ctx, messages,
    advance(ms = 1000) { now += ms; }, now: () => now, hideHuman() { present = false; } };
}

test('new HundredGame inherits real public bets without game-specific robot orchestration', t => {
  class NewHundred extends HundredGame {
    constructor() { super({ id: 'new-hundred', kind: 'hundred', roomTypes: [987], minBet: 100 }); }
    createAreas() { return [{ areaId: 1, total: 0 }]; }
  }
  const f = fixture(t, new NewHundred());
  Object.defineProperty(f.table, 'hand', { get() { assert.fail('random betting must never inspect the hidden hand'); } });
  f.game.tick(f.ctx);
  f.advance(); f.game.tick(f.ctx);
  assert.equal(f.table.playerBets.size, 2);
  assert.equal(f.table.totalBetsByArea[0].total, 200);
  assert.equal(f.human.wallet, 1000000);
  assert.ok(f.messages.some(m => m.id === PUSH.BET_BROADCAST && m.data.allPlayerBets[0].total === 200));
  assert.equal(f.messages.some(m => m.uid === 42 && m.id === PUSH.BET_RESPONSE), false,
    'private robot bets cannot replace the human betting panel');
});

test('unvisited and disabled hundred rooms do not create robot traffic', t => {
  const f = fixture(t);
  f.hideHuman(); f.game.tickRobots(f.ctx);
  assert.equal(f.table.hundredRobots, undefined);
  f.io.forEachPlayer = fn => fn(f.human);
  f.table.cfg.robot_behavior.enabled = false;
  f.game.tickRobots(f.ctx);
  assert.equal(f.table.hundredRobots, undefined);
});

for (let mode = 1; mode <= 5; mode++) {
  test('hundred Holdem mode ' + mode + ' shares normal betting and exactly-once isolated robot settlement', async t => {
    const f = fixture(t, new HundredHoldemGame(), mode);
    f.game.onMessage(f.ctx, 6105, {});
    holdem.beginRound(f.io, f.table, f.now());
    f.table.state = holdem.PHASE.BETTING;
    f.table.phaseEndsAt = f.now() + 15000;
    f.game.tickRobots(f.ctx);
    f.advance(); f.game.tickRobots(f.ctx);
    assert.equal(f.table.playerBets.size, 2);
    assert.equal(f.table.totalBetsByArea[1], 200);
    const profiles = [...f.table.hundredRobots.profiles.values()];
    for (const p of profiles) assert.equal(p.session.wallet, p.openingWallet - 100);
    f.table.hand.winner = 'player';
    f.table.hand.winningAreas = [1, 4];
    await holdem.settleRound(f.ctx);
    const profit = Math.floor(100 * f.table.rules.betAreaOdds[1]);
    for (const p of profiles) assert.equal(p.session.wallet, p.openingWallet + profit);
    assert.equal(f.table.systemInningScore, -2 * profit);
    assert.equal(f.table.hundredSettledInning, f.table.inning);
    assert.equal(await holdem.settleRound(f.ctx), false);
    for (const p of profiles) assert.equal(p.session.wallet, p.openingWallet + profit);
    assert.equal(f.human.wallet, 1000000);
    const own = f.messages.filter(m => m.uid === 42 && m.id === PUSH.MB_ROOM_BET_SETTLE);
    assert.equal(own.length, 1);
    assert.equal(own[0].data.realScore, 0, 'robot wins cannot become human wins');
  });
}

test('robots only bet in state 2, respect the close deadline and never exceed the per-round limit', t => {
  const f = fixture(t);
  for (const state of [0, 1, 4, 5, 6, 7]) {
    f.table.state = state;
    f.game.tickRobots(f.ctx); f.advance();
  }
  assert.equal(f.table.playerBets.size, 0);
  f.table.state = 2;
  f.table.phaseEndsAt = f.now() + 500;
  f.game.tickRobots(f.ctx);
  assert.equal(f.table.playerBets.size, 0);
  f.table.phaseEndsAt = f.now() + 15000;
  f.game.tickRobots(f.ctx); f.advance(); f.game.tickRobots(f.ctx);
  for (let i = 0; i < 5; i++) { f.advance(); f.game.tickRobots(f.ctx); }
  assert.equal(f.table.totalBetsByArea[1], 200, 'each robot has exactly one ordinary accepted bet');
});

test('robot traffic remains autonomous after the human leaves; departures wait for settlement and reuse the same bankroll', async t => {
  const f = fixture(t);
  holdem.beginRound(f.io, f.table, f.now());
  f.table.state = 2; f.table.phaseEndsAt = f.now() + 15000;
  f.game.tickRobots(f.ctx); f.hideHuman();
  f.advance(); f.game.tickRobots(f.ctx);
  assert.equal(f.table.playerBets.size, 2);
  const profiles = [...f.table.hundredRobots.profiles.values()];
  f.table.cfg.robot_behavior.leaveProbability = 1;
  f.table.state = 4;
  f.advance(); f.game.tickRobots(f.ctx);
  assert.ok(profiles.every(p => p.inRoom), 'pending bets retain their robot owner');
  f.table.hand.winner = 'banker'; f.table.hand.winningAreas = [2, 4];
  await holdem.settleRound(f.ctx);
  f.advance(); f.game.tickRobots(f.ctx);
  assert.ok(profiles.every(p => !p.inRoom));
  assert.ok(profiles.every(p => p.session.wallet === p.openingWallet - 100));
  f.table.cfg.robot_behavior.leaveProbability = 0;
  f.table.cfg.robot_behavior.joinProbability = 1;
  f.advance(3000); f.game.tickRobots(f.ctx);
  assert.equal(profiles[0].inRoom, true);
  assert.equal(profiles[0].session.wallet, profiles[0].openingWallet - 100);
});

test('a bankrupt robot leaves after losing settlement and is never refilled', async t => {
  const f = fixture(t);
  f.table.cfg.robot_behavior.initialRobots = 1;
  holdem.beginRound(f.io, f.table, f.now());
  f.table.state = 2; f.table.phaseEndsAt = f.now() + 15000;
  f.game.tickRobots(f.ctx);
  const p = [...f.table.hundredRobots.profiles.values()][0];
  p.session.wallet = 100;
  f.advance(); f.game.tickRobots(f.ctx);
  assert.equal(p.session.wallet, 0);
  f.advance(); f.game.tickRobots(f.ctx);
  assert.equal(p.inRoom, true, 'zero-balance bettor still has unsettled responsibility');
  f.table.hand.winner = 'banker'; f.table.hand.winningAreas = [2, 4];
  await holdem.settleRound(f.ctx);
  f.game.tickRobots(f.ctx);
  assert.equal(p.inRoom, false);
  assert.equal(p.session.wallet, 0);
});

test('hot-reloading hundred robot code preserves profiles, funds and scheduled actions', async t => {
  const f = fixture(t);
  f.table.state = 2; f.table.phaseEndsAt = f.now() + 15000;
  f.game.tickRobots(f.ctx); f.advance(); f.game.tickRobots(f.ctx);
  const state = f.table.hundredRobots;
  const p = [...state.profiles.values()][0];
  const wallet = p.session.wallet, nextBet = p.nextBetAt;
  const { HundredHoldemGame: HotGame } = await import('../../../game-server/src/games/hundred-holdem/HundredHoldemGame.js?v=robot-resident-state');
  new HotGame().tickRobots(f.ctx);
  assert.equal(f.table.hundredRobots, state);
  assert.equal(p.session.wallet, wallet);
  assert.equal(p.nextBetAt, nextBet);
  assert.equal(state.profiles.size, 2);
});

test('baccarat inherits public robot bets and settles their simulated wallets without RPC', t => {
  const f = fixture(t, new BaccaratGame());
  f.game.enter(f.table, f.human);
  f.game.tickRobots(f.ctx); f.advance(); f.game.tickRobots(f.ctx);
  assert.equal(f.table.playerBets.size, 2);
  assert.equal(f.table.totalBetsByArea[0].total, 200);
  const profiles = [...f.table.hundredRobots.profiles.values()];
  f.table.lastResult = { player: [0, 1], banker: [12, 11], areas: [1], p: 3, b: 0 };
  baccarat.applyCycle(f.io, f.table, 5);
  assert.equal(f.table.state, 5, 'comparison cannot accidentally reopen betting');
  f.advance(); f.game.tickRobots(f.ctx);
  assert.equal(f.table.totalBetsByArea[0].total, 200);
  baccarat.applyCycle(f.io, f.table, 6);
  for (const p of profiles) assert.equal(p.session.wallet, p.openingWallet + 95);
  baccarat.applyCycle(f.io, f.table, 6);
  for (const p of profiles) assert.equal(p.session.wallet, p.openingWallet + 95);
  assert.equal(f.human.wallet, 1000000);
});

test('shared bet validation rejects a bad batch before any human or robot debit', t => {
  const f = fixture(t, new BaccaratGame());
  assert.equal(f.game.placeBet(f.ctx, { params: [{ areaId: 1, total: 100 }, { areaId: 999, total: 100 }] }), false);
  assert.equal(f.human.wallet, 1000000);
  assert.equal(f.table.playerBets.size, 0);
  assert.ok(f.table.totalBetsByArea.every(row => row.total === 0));
});

test('random stakes always fit public limits and never need private card data', () => {
  let seed = 17;
  const rng = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 300; i++) {
    const view = { minBet: 100, maxBet: 3000, balance: 100 + Math.floor(rng() * 100000),
      areas: [{ areaId: 1, odds: 1.91 }, { areaId: 4, odds: 1.61 }] };
    const bet = chooseHundredBet(view, rng);
    assert.ok([1, 4].includes(bet.areaId));
    assert.ok(Number.isSafeInteger(bet.total) && bet.total >= 100 && bet.total <= Math.min(view.balance, view.maxBet));
  }
});
