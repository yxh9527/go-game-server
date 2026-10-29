import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry } from '../../../../game-server/src/registry.js';
import { decodeFrame, encodeFrame } from '../../../../game-server/src/codec.js';
import { PUSH, SEND } from '../../../../game-server/src/messages.js';
import { HundredHoldemGame } from '../../../../game-server/src/games/hundred-holdem/HundredHoldemGame.js';
import * as engine from '../../../../game-server/src/games/hundred-holdem/engine.js';

function fixture(playMode = 1) {
  const row = seedRooms().find(item => item.room_type === 50 && item.play_mode === playMode);
  const game = new HundredHoldemGame();
  const table = game.createTable(row.game_room_config_id * 10000 + row.room_index, 50, row);
  const session = { userId: 11, wallet: 10000 };
  const messages = [];
  const io = {
    broadcast: (id, data) => messages.push({ userId: 0, id, data: structuredClone(data) }),
    sendUser: (userId, id, data) => messages.push({ userId, id, data: structuredClone(data) }),
    forEachPlayer: fn => fn(session),
  };
  const send = (id, data) => messages.push({ userId: session.userId, id, data: structuredClone(data) });
  const runtime = { wallet: {
    debit(user, amount) { if (user.wallet < amount) return { ok: false }; user.wallet -= amount; return { ok: true }; },
    credit(user, amount) { user.wallet += amount; return { ok: true }; },
  } };
  const ctx = { table, session, io, runtime, send };
  return { game, row, table, session, messages, io, ctx };
}

test('five client modes have the documented visible community-card counts', () => {
  const expected = { 1: 0, 2: 3, 3: 2, 4: 1, 5: 0 };
  for (const [mode, visible] of Object.entries(expected)) {
    const { row, table } = fixture(Number(mode));
    assert.equal(table.rules.playMode, Number(mode));
    assert.equal(table.rules.boardCards, visible);
    assert.equal(table.rules.privateCards, Number(mode) !== 5);
    assert.equal(row.payload && JSON.parse(row.payload).hundredParams.gameName,
      `${table.rules.name}(底注1)`);
  }
});

test('mode snapshots mask unrevealed cards and use protocol room fields', () => {
  for (const [mode, count] of [[1, 0], [2, 3], [3, 2], [4, 1], [5, 0]]) {
    const { table } = fixture(mode);
    engine.beginRound({ broadcast() {} }, table, 1000, () => 0.5);
    const snapshot = engine.roomSnapshot(table, { userId: 1, wallet: 1234 });
    assert.equal(snapshot.roomType, 50);
    assert.equal(snapshot.hundredParams.gameRoomConfigId, table.rules.gameRoomConfigId);
    assert.equal(snapshot.dealPokers.publicCards.filter(card => card >= 0).length, count);
    if (mode === 5) assert.ok(snapshot.dealPokers.bankerCards.every(card => card === -1));
    else assert.ok(snapshot.dealPokers.bankerCards.every(card => card >= 0));
  }
});

test('room join registers an observer; enter request returns one snapshot without double-counting', () => {
  const f = fixture();
  f.game.onJoin(f.ctx);
  assert.equal(f.table.people, 1);
  assert.equal(f.table.visitors.has(f.session.userId), true);
  assert.equal(f.session.hundredRoomIds.has(f.table.roomId), true);
  assert.equal(f.messages.some(item => item.id === 6205 && item.userId === 11), false,
    'the room snapshot is sent only after the client has loaded the game scene');
  f.game.onMessage(f.ctx, 6105, {});
  assert.equal(f.messages.filter(item => item.id === 6205 && item.userId === 11).length, 1);
  assert.equal(f.table.people, 1, 'explicit enter after join must not double-count');
});

test('websocket join waits for client 6105 before sending the 6205 room snapshot', async () => {
  const registry = createRegistry();
  const config = seedRooms().find(item => item.room_type === 50 && item.play_mode === 1);
  const roomId = config.game_room_config_id * 10000 + config.room_index;
  const received = [];
  const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
  registry.bind(ws, { userId: 12, agentId: 0, roomId, wallet: 1000, inRoom: false, authenticated: true });
  const handler = await createHandler({
    hotVersion: 'hundred-entry-order', registry, configs: [config],
    findConfig: () => config,
    wallet: { debit(session, amount) {
      if (session.wallet < amount) return { ok: false };
      session.wallet -= amount;
      return { ok: true };
    } },
    log: { info() {}, error() {} },
  });

  await handler.onMessage(ws, encodeFrame(SEND.SEND_JOIN_ROOM, { roomId, roomType: 50, isOb: true }));
  assert.equal(received.some(frame => frame.msgid === PUSH.ROOM_TYPE_RESULT), true);
  assert.equal(received.some(frame => frame.msgid === PUSH.ENTER_RESPONSE), false);

  await handler.onMessage(ws, encodeFrame(SEND.ENTER, { roomId, roomType: 50 }));
  const snapshots = received.filter(frame => frame.msgid === PUSH.ENTER_RESPONSE);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].payload.roomId, roomId);
  assert.equal(snapshots[0].payload.playerId, 12);
});

test('bets validate atomically, debit once, and reject bets outside state 2', async () => {
  const f = fixture();
  engine.beginRound(f.io, f.table, 1000, () => 0.5);
  f.table.state = engine.PHASE.BETTING;
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, roomId: f.table.roomId,
    params: [{ areaId: 1, total: 100 }, { areaId: 8, total: 100 }] }), false);
  assert.equal(f.session.wallet, 10000);
  assert.equal(f.table.playerBets.size, 0);
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, roomId: f.table.roomId,
    params: [{ areaId: 1, total: 100 }, { areaId: 3, total: 200 }] }), true);
  assert.equal(f.session.wallet, 9700);
  assert.equal(f.table.totalBetsByArea[3], 200);
  f.table.state = engine.PHASE.SHOWDOWN;
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: 100 }] }), false);
});

test('settlement sends a single personalized result to each viewer', async () => {
  const f = fixture();
  f.game.onMessage(f.ctx, 6105, {});
  engine.beginRound(f.io, f.table, 1000, () => 0.5);
  f.table.state = engine.PHASE.BETTING;
  engine.acceptBet(f.ctx, { roomType: 50, roomId: f.table.roomId,
    params: [{ areaId: 1, total: 100 }] });
  await engine.settleRound(f.ctx);
  assert.equal(f.messages.filter(item => item.id === 6229 && item.userId === 11).length, 1);
  assert.equal(f.messages.some(item => item.id === 6229 && item.userId === 0), false);
  assert.equal(f.messages.find(item => item.id === 6229 && item.userId === 11).data.points, f.session.wallet);
  assert.equal(await engine.settleRound(f.ctx), false);
});

test('room state follows the original 0, 1, 2, 4, 5, 6, 7 round sequence', () => {
  const { table, io } = fixture();
  engine.beginRound(io, table, 1000, () => 0.5);
  assert.equal(table.state, 1);
  engine.tick(io, table, 2000);
  assert.equal(table.state, 2);
  engine.tick(io, table, 17000);
  assert.equal(table.state, 4);
  table.phaseEndsAt = 20000;
  engine.tick(io, table, 20000);
  assert.equal(table.state, 5);
  return new Promise(resolve => setImmediate(resolve)).then(() => {
    table.phaseEndsAt = 20001;
    engine.tick(io, table, 20001);
    assert.equal(table.state, 6);
    engine.tick(io, table, 25001);
    assert.equal(table.state, 7);
  });
});
