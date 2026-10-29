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

test('five modes send object odds to multi-bet cards and numeric odds to the main table', async () => {
  for (const mode of [1, 2, 3, 4, 5]) {
    const f = fixture(mode);
    engine.beginRound(f.io, f.table, Date.now() - 1000);
    engine.tick(f.io, f.table, Date.now(), f.ctx);
    await engine.settleRound(f.ctx);
    const deal = f.messages.find(m => m.id === PUSH.DEAL_CARDS_AND_ODDS).data;
    const states = f.messages.filter(m => m.id === PUSH.MB_SNC_ROOM_STATE);
    assert.ok(states.some(m => m.data.state === engine.PHASE.BETTING));
    for (const { data } of states) {
      for (const id of [1, 2, 3, 4, 5, 6, 7]) {
        assert.deepEqual(data.areaOdds[id], { id, odds: f.table.rules.betAreaOdds[id] });
        assert.ok(Number.isFinite(Number(data.areaOdds[id].odds)), 'native card reads odds as a number');
        assert.equal(deal.areaOdds[id], data.areaOdds[id].odds, 'both protocols share the same configured odds');
      }
    }
    assert.deepEqual(engine.roomSnapshot(f.table, f.session).hundredParams.betAreaOdds,
      states.at(-1).data.areaOdds, 'reconnect restores the same card odds');
    assert.equal(typeof f.table.rules.betAreaOdds[1], 'number', 'wire conversion does not mutate settlement rules');
  }
});

for (const mode of [1, 2, 3, 4, 5]) {
  test('mode ' + mode + ' keeps native multi-bet clocks synchronized across phases and reconnect', async t => {
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const f = fixture(mode);
    engine.beginRound(f.io, f.table, now);
    now += 1000;
    engine.tick(f.io, f.table, now, f.ctx);
    const betting = f.messages.filter(m => m.id === PUSH.MB_SNC_ROOM_STATE).at(-1).data;
    assert.equal(betting.state, engine.PHASE.BETTING);
    assert.equal(betting.countDown, 20000, 'original incremental card clock is 20 seconds');
    assert.equal(betting.customData, 2, 'original model accepts only its matching context');
    now += 7000;
    assert.equal(engine.roomSnapshot(f.table, f.session).countDown, 13000, 'reconnect uses remaining milliseconds');
    now += 13000;
    engine.tick(f.io, f.table, now, f.ctx);
    await engine.settleRound(f.ctx);
    for (const message of f.messages.filter(m => m.id === PUSH.MB_SNC_ROOM_STATE)) {
      assert.equal(message.data.customData, 2);
      assert.equal(message.data.roomId, f.table.roomId);
      assert.ok(Number.isFinite(message.data.countDown) && message.data.countDown >= 0);
    }
  });
}

test('hot module aligns the next betting clock without resetting a resident hand or pending bets', t => {
  const now = 100000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  f.table.config = { ...f.table.config, betSeconds: 15 };
  engine.beginRound(f.io, f.table, now - 1000);
  const hand = f.table.hand;
  f.table.playerBets.set(f.session.userId, [{ areaId: 1, total: 100 }]);
  f.game.tick(f.ctx);
  assert.equal(f.table.hand, hand);
  assert.equal(f.table.playerBets.get(f.session.userId)[0].total, 100);
  assert.equal(f.table.phaseEndsAt - now, 20000);
});

test('multi-bet success and failure receipts carry the original client context', () => {
  const f = fixture();
  engine.beginRound(f.io, f.table);
  f.table.state = engine.PHASE.BETTING;
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: 100 }] }, PUSH.MB_ROOM_BET_RES), true);
  assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: -1 }] }, PUSH.MB_ROOM_BET_RES), false);
  const receipts = f.messages.filter(m => m.id === PUSH.MB_ROOM_BET_RES);
  assert.deepEqual(receipts.map(m => m.data.customData), [2, 2]);
  assert.deepEqual(receipts.map(m => m.data.code), [0, 1]);
});

for (const mode of [1, 2, 3, 4, 5]) {
  test('mode ' + mode + ' records settled cards and private area results for native history', async () => {
    const f = fixture(mode);
    f.table.playerSessions.set(11, f.session);
    engine.beginRound(f.io, f.table);
    f.table.state = engine.PHASE.BETTING;
    assert.deepEqual(engine.historyList(f.table, 11).list, [], 'live hands are not reviewable');
    assert.equal(engine.acceptBet(f.ctx, { roomType: 50, params: [{ areaId: 1, total: 100 }, { areaId: 4, total: 200 }] }), true);
    const other = { userId: 12, wallet: 10000 };
    f.table.playerSessions.set(12, other);
    engine.acceptBet({ ...f.ctx, session: other }, { roomType: 50, params: [{ areaId: 2, total: 300 }] });
    await engine.settleRound(f.ctx);
    assert.deepEqual(engine.historyList(f.table, 11), { gameRoomId: f.table.roomId, list: [1] });
    const detail = engine.historyDetail(f.table, 11, 1);
    assert.deepEqual(Object.keys(detail.betDetailTableMap), ['1', '4']);
    assert.equal(detail.betDetailTableMap[1].betScore, 100);
    assert.equal(detail.betDetailTableMap[4].betScore, 200);
    assert.equal(detail.betDetailTableMap[1].odds, f.table.rules.betAreaOdds[1]);
    const result = f.messages.find(m => m.id === PUSH.MB_ROOM_BET_SETTLE && m.userId === 11).data;
    assert.equal(Object.values(detail.betDetailTableMap).reduce((n, r) => n + r.realScore, 0), result.realScore);
    assert.deepEqual(detail.showdownPokers, result.showdownPokers);
    assert.deepEqual(detail.showdownTypes, result.showdownTypes);
    assert.deepEqual(detail.winAreaIds, result.winningAreas);
    assert.deepEqual(detail.tieAreaIds, result.tieAreas);
    assert.deepEqual(detail.lostAreaIds, result.lostAreas);
    assert.equal(detail.showdownPokers.board.length, 5);
    assert.equal(detail.showdownPokers.banker.length, 2);
    assert.equal(detail.showdownPokers.player.length, 2);
    assert.ok(Object.values(detail.showdownPokers).flat().every(card => Number.isInteger(card) && card >= 0 && card < 52));
    assert.deepEqual(Object.keys(engine.historyDetail(f.table, 12, 1).betDetailTableMap), ['2']);
    assert.deepEqual(engine.historyList(f.table, 99).list, []);
    assert.equal(engine.historyDetail(f.table, 99, 1), null);
    assert.equal(await engine.settleRound(f.ctx), false);
    assert.deepEqual(engine.historyList(f.table, 11).list, [1], 'duplicate settlement cannot duplicate history');
    detail.showdownPokers.board[0] = -1;
    detail.betDetailTableMap[1].realScore = 99999;
    f.table.inning += 1;
    engine.beginRound(f.io, f.table);
    assert.deepEqual(engine.historyDetail(f.table, 11, 1).showdownPokers, result.showdownPokers);
  });
}

test('spectator history shows cards without inventing bets, survives hot reload and expires after eight hours', async t => {
  let now = 100000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture();
  engine.beginRound(f.io, f.table, now);
  await engine.settleRound(f.ctx);
  assert.deepEqual(engine.historyDetail(f.table, 11, 1).betDetailTableMap, {});
  const hot = await import('../../../../game-server/src/games/hundred-holdem/engine.js?v=history-survives-reload');
  assert.deepEqual(hot.historyList(f.table, 11).list, [1]);
  assert.ok(hot.historyDetail(f.table, 11, 1));
  for (const inning of [0, -1, NaN, Infinity, 1.5, 2]) assert.equal(hot.historyDetail(f.table, 11, inning), null);
  now += 8 * 3600000;
  assert.deepEqual(hot.historyList(f.table, 11).list, []);
  assert.equal(f.table.hundredHistory.length, 0);
});

test('native hundred history requests stay on the hundred channel and isolate agent, room and user', async () => {
  const { handler, registry, socket } = await nativeEntryFixture();
  const main = socket(), hundred = socket();
  const login = { userId: 71, userToken: 'dev', roomId: 700000, openHundredGame: true };
  await main.send(SEND.ROOM_LOGIN, login);
  await main.send(SEND.SEND_JOIN_ROOM, { roomId: 700000, roomType: 19, isOb: true });
  await hundred.send(SEND.ROOM_LOGIN, login);
  await hundred.send(SEND.ENTER, { roomType: 50, playMode: 1 });
  const session = registry.session(hundred.ws);
  const table = registry.getTable(session.hundredRoomId, session.agentId, session.hundredGameId);
  const io = { broadcast() {}, sendUser() {}, forEachPlayer: fn => fn(session) };
  engine.beginRound(io, table);
  await engine.settleRound({ table, io });
  const requestList = () => hundred.send(SEND.REQUEST_100_RECORD, { roomType: 50, roomId: table.roomId });
  await requestList();
  assert.deepEqual(hundred.frames.at(-1).payload, { gameRoomId: table.roomId, list: [1] });
  await hundred.send(SEND.REQUEST_ONE_RECORD, { gameRoomId: table.roomId, currInning: 1 });
  assert.equal(hundred.frames.at(-1).msgid, 6222);
  assert.equal(hundred.frames.at(-1).payload.currInning, 1);
  assert.equal(main.frames.some(f => [6221, 6222].includes(f.msgid)), false);
  await hundred.send(SEND.REQUEST_ONE_RECORD, { gameRoomId: table.roomId + 1, currInning: 1 });
  assert.deepEqual(hundred.frames.at(-1).payload.list, []);
  await hundred.send(SEND.REQUEST_ONE_RECORD, { gameRoomId: table.roomId, currInning: -1 });
  assert.equal(hundred.frames.at(-1).msgid, 6221, 'invalid detail refreshes the safe list');
  assert.equal(registry.session(main.ws).roomId, 700000);
  await hundred.send(SEND.EXIT, { roomType: 50 });
  await requestList();
  assert.deepEqual(hundred.frames.at(-1).payload.list, []);
});

test('history keeps only the latest one hundred completed rounds in ascending client page order', async () => {
  const { record, list, detail } = await import('../../../../cache/game-server/hundred-holdem-history.js');
  const f = fixture();
  const viewers = new Map([[11, f.session]]);
  for (let inning = 1; inning <= 105; inning += 1) {
    f.table.inning = inning;
    record(f.table, { showdownPokers: {}, showdownTypes: {}, winAreaIds: [], lostAreaIds: [], tieAreaIds: [] }, viewers, new Map());
  }
  assert.equal(f.table.hundredHistory.length, 100);
  const innings = list(f.table, 11).list;
  assert.equal(innings[0], 6);
  assert.equal(innings.at(-1), 105);
  assert.equal(detail(f.table, 11, 5), null);
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
  engine.tick(io, table, table.phaseEndsAt);
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
