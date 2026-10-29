import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
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

async function nativeEntryFixture() {
  const registry = createRegistry(), configs = seedRooms();
  const runtime = { hotVersion: 'native-hundred-entry', registry, configs, findConfig,
    wallet: { load: async session => { session.wallet = 10000; }, persist: async () => {} },
    gateway: { validateToken: async () => true, getLoginData: async () => ({ agentId: 77, userName: 'player' }) },
    log: { info() {}, error() {} } };
  const handler = await createHandler(runtime);
  const socket = () => {
    const frames = [];
    const ws = { readyState: 1, send: frame => frames.push(decodeFrame(frame)) };
    return { ws, frames, send: (id, body) => handler.onMessage(ws, encodeFrame(id, body)) };
  };
  return { handler, registry, socket };
}

test('native hundred socket enters after login without joining or replacing its main Holdem room', async () => {
  const { handler, registry, socket } = await nativeEntryFixture();
  const main = socket(), hundred = socket();
  const login = { userId: 12, userToken: 'dev', roomId: 700000, openHundredGame: true };
  await main.send(SEND.ROOM_LOGIN, login);
  await main.send(SEND.SEND_JOIN_ROOM, { roomId: login.roomId, roomType: 19, isOb: true, openHundredGame: true });
  const host = main.frames.find(f => f.msgid === PUSH.ROOM_TYPE_RESULT).payload;
  assert.equal(host.roomType, 19);
  assert.ok(host.conf.dzpkParams);
  assert.equal(host.conf.hundredSwitch, true);
  assert.equal(host.openHundredGame, true);
  const mainTable = registry.getTable(login.roomId, 77, 'holdem');
  assert.equal(mainTable.members.length, 0);
  assert.ok(mainTable.observers.some(p => p.uid === 12));

  await hundred.send(SEND.ROOM_LOGIN, login);
  await hundred.send(SEND.ENTER, { roomType: 50, playMode: 3 });
  const snapshot = hundred.frames.find(f => f.msgid === PUSH.ENTER_RESPONSE).payload;
  assert.equal(snapshot.roomType, 50);
  assert.equal(snapshot.playMode, 3);
  assert.equal(hundred.frames.some(f => f.msgid === PUSH.ROOM_TYPE_RESULT), false);
  assert.equal(registry.session(hundred.ws).roomId, login.roomId);
  assert.equal(registry.session(hundred.ws).inRoom, false);
  await hundred.send(SEND.MB_REG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 50 }], customData: 2 });
  const registered = hundred.frames.find(f => f.msgid === PUSH.MB_REGED_ROOM_INFOS).payload;
  assert.equal(registered.customData, 2);
  assert.deepEqual(registered.roomInfos.map(r => r.playMode).sort(), [1, 2, 3, 4, 5]);
  await handler.tick();
  assert.equal(main.frames.some(f => f.msgid === PUSH.MB_SNC_ROOM_STATE), false);
  assert.ok(hundred.frames.some(f => f.msgid === PUSH.MB_SNC_ROOM_STATE));
  for (const frame of hundred.frames.filter(f => [PUSH.GAME_STATE, PUSH.DEAL_CARDS_AND_ODDS].includes(f.msgid))) {
    assert.equal(frame.payload.roomId ?? snapshot.roomId, snapshot.roomId, 'single-table events cannot leak sibling state');
  }
  await handler.onClose(hundred.ws);
  assert.ok(mainTable.observers.some(p => p.uid === 12), 'closing channel 222 cannot remove the main observer');
  assert.equal(registry.session(main.ws).inRoom, true);
  for (const table of registry.listAgentGameRooms(77, 'hundred-holdem')) {
    assert.equal(table.visitors.has(12), false);
  }
});

test('shared server hundred entry, unsubscribe and exit preserve normal table identity', async () => {
  const { registry, socket } = await nativeEntryFixture();
  const main = socket();
  await main.send(SEND.ROOM_LOGIN, { userId: 13, userToken: 'dev', roomId: 700000, openHundredGame: true });
  await main.send(SEND.SEND_JOIN_ROOM, { roomId: 700000, roomType: 19, isOb: true, openHundredGame: true });
  await main.send(SEND.ENTER, { roomType: 50, playMode: 5 });
  assert.equal(registry.session(main.ws).gameId, 'holdem');
  assert.equal(registry.session(main.ws).roomId, 700000);
  await main.send(SEND.MB_REG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 50 }], customData: 2 });
  await main.send(SEND.MB_UNREG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 50 }], customData: 2 });
  assert.equal(registry.session(main.ws).hundredRoomIds.size, 0);
  for (const table of registry.listAgentGameRooms(77, 'hundred-holdem')) assert.equal(table.visitors.has(13), false);
  await main.send(SEND.EXIT, { roomType: 50 });
  assert.equal(registry.session(main.ws).inRoom, true);
  await main.send(SEND.LOGIN_ROOM, { roomId: 700000 });
  assert.ok(main.frames.some(f => f.msgid === PUSH.ROOM_INFO));
  await main.send(SEND.SEND_LEVEL_OUT);
  assert.ok(main.frames.some(f => f.msgid === PUSH.USER_LEVEL_ROOM));
});

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

test('hot engine uses its versioned message table even if the boot module lacks new IDs', async () => {
  const keys = ['DEAL_CARDS_AND_ODDS', 'MB_SNC_ROOM_STATE', 'MB_ROOM_BET_SETTLE'];
  const saved = keys.map(key => PUSH[key]);
  try {
    for (const key of keys) delete PUSH[key];
    const hot = await import('../../../../game-server/src/games/hundred-holdem/engine.js?v=hot-message-regression');
    const f = fixture();
    hot.beginRound(f.io, f.table, 1000, () => 0.5);
    await hot.settleRound(f.ctx);
    for (const id of [6212, 6228, 6229]) assert.ok(f.messages.some(m => m.id === id), 'real wire id ' + id);
    assert.ok(f.messages.every(m => Number.isSafeInteger(m.id) && m.id > 0));
  } finally { keys.forEach((key, i) => { PUSH[key] = saved[i]; }); }
});

test('mode snapshots mask unrevealed cards and use protocol room fields', () => {
  for (const [mode, count] of [[1, 0], [2, 3], [3, 2], [4, 1], [5, 0]]) {
    const { table } = fixture(mode);
    engine.beginRound({ broadcast() {} }, table, 1000, () => 0.5);
    const snapshot = engine.roomSnapshot(table, { userId: 1, wallet: 1234 });
    assert.equal(snapshot.roomType, 50);
    assert.equal(snapshot.hundredParams.gameRoomConfigId, table.rules.gameRoomConfigId);
    assert.deepEqual(snapshot.hundredParams.betAreaOdds[1], { id: 1, odds: table.rules.betAreaOdds[1] });
    assert.equal(typeof snapshot.areaOdds[1], 'number');
    assert.deepEqual(Object.values(snapshot.ways).map(row => row.max), [100, 33, 5]);
    assert.ok(Object.values(snapshot.ways).every(row => Array.isArray(row.ways)));
    assert.equal(Number.isFinite(snapshot.systemInningScore), true);
    assert.equal(Number.isFinite(snapshot.systemTodayTotalScore), true);
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
  const snapshot = engine.roomSnapshot(f.table, f.session);
  assert.deepEqual(snapshot.ownBets[3], { areaId: 3, total: 200 });
  f.table.state = engine.PHASE.SHOWDOWN;
  const reconnect = engine.roomSnapshot(f.table, f.session);
  assert.ok(Array.isArray(reconnect.winningAreas));
  assert.ok(Array.isArray(reconnect.tieAreas));
  assert.ok(Array.isArray(reconnect.lostAreas));
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: 100 }] }), false);
});

test('exiting after a bet preserves its owner until the hand is settled', async () => {
  const f = fixture();
  f.game.onMessage(f.ctx, SEND.ENTER, {});
  engine.beginRound(f.io, f.table, 1000, () => 0.5);
  f.table.state = engine.PHASE.BETTING;
  f.table.hand.winningAreas = [1, 4];
  f.table.hand.winner = 'player';
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: 100 }] }), true);
  assert.equal(f.game.removeViewer(f.table, f.session), true);
  assert.equal(f.table.playerSessions.get(11), f.session);
  await engine.settleRound(f.ctx);
  assert.equal(f.session.wallet, 10191, 'return the stake and actual profit after exit');
  assert.equal(f.table.playerSessions.has(11), false);
  const settled = f.session.wallet;
  assert.equal(await engine.settleRound(f.ctx), false);
  assert.equal(f.session.wallet, settled, 'never pay a hand twice');
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
  const { table, io, messages } = fixture();
  engine.beginRound(io, table, 1000, () => 0.5);
  assert.equal(table.state, 1);
  engine.tick(io, table, 2000);
  assert.equal(table.state, 2);
  engine.tick(io, table, 17000);
  assert.equal(table.state, 4);
  const showdown = messages.findIndex(m => m.id === PUSH.SHOWDOWN_POKERS);
  assert.ok(showdown >= 0);
  for (const id of [PUSH.MB_SNC_ROOM_STATE, PUSH.GAME_STATE]) {
    const state = messages.findIndex(m => m.id === id && m.data.state === 4);
    assert.ok(state > showdown, 'open-card data must exist before state 4: ' + id);
  }
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
