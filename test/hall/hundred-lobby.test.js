import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { createApp } from '../../hall/src/create-app.js';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { loadGames, gameOf } from '../../game-server/src/games/catalog.js';
import { hundredLobbySnapshot, listHundredLobbyRooms } from '../../game-server/src/core/hundred-lobby.js';
import { seedRooms } from '../../cache/rpc/seed.js';

test('hundred lobby snapshots cover every game without creating rooms or leaking future results', async () => {
  const games = await loadGames('hundred-lobby-unit');
  const rows = seedRooms().filter(row => gameOf(games, row.room_type)?.kind === 'hundred');
  const runtime = { configs: rows, registry: createRegistry() };
  const select = type => gameOf(games, type);
  const cold = listHundredLobbyRooms(runtime, select, 1);
  assert.equal(cold.length, rows.length);
  assert.equal(runtime.registry.tables.size, 0);
  for (const row of cold) {
    assert.equal(row.gameStatus, 0);
    assert.equal(row.gameStatusDuration, 0);
    const info = JSON.parse(row.extendInfo);
    assert.equal(info.countDown, 0);
    if (row.roomType >= 53 && row.roomType <= 57) {
      assert.equal(info.defaultOuter.length, 24);
      assert.equal(info.defaultInner.length, 24);
    }
  }
  for (const row of rows.filter((row, index) => rows.findIndex(other => other.room_type === row.room_type) === index)) {
    const game = select(row.room_type), now = Date.now();
    const table = game.createTable(row.game_room_config_id * 10000 + (row.room_index || 0), row.room_type, row);
    runtime.registry.setTable(table.roomId, table, 1, game.id);
    if (game.engine) game.engine.beginRound({ broadcast() {} }, table, now);
    table.state = 2;
    table.phaseEndsAt = now + 12500;
    const own = game.enterSnapshot(table, { userId: 0, wallet: 0 });
    const live = hundredLobbySnapshot(game, table, now);
    assert.equal(live.gameStatus, 2);
    assert.equal(live.gameStatusDuration, 12500);
    const info = JSON.parse(live.extendInfo);
    assert.deepEqual(info.showdownPokers, own.showdownPokers);
    assert.deepEqual(info.dealPokers, own.dealPokers);
    for (const field of ['ownBets', 'points', 'playerId', 'areaWinningScores', 'winningAreas', 'outerValue', 'innerValue']) {
      assert.equal(Object.hasOwn(info, field), false, game.id + ': ' + field);
    }
    assert.ok(!live.extendInfo.includes('NaN'));
    assert.equal(hundredLobbySnapshot(game, table, now + 14000).gameStatusDuration, 0);
    const other = listHundredLobbyRooms(runtime, select, 2, { roomType: row.room_type });
    assert.ok(other.every(item => item.gameStatus === 0), 'agent cannot see another agent\'s hand');
  }
  const count = runtime.registry.tables.size;
  listHundredLobbyRooms(runtime, select, 1);
  assert.equal(runtime.registry.tables.size, count);
  assert.equal(runtime.registry.sessions.size, 0);
});

test('op 38 reads authenticated live phases, wheels and roads without joining a game', async t => {
  const rows = seedRooms().filter(row => [53, 54, 55, 56, 57].includes(row.room_type));
  const registry = createRegistry(), errors = [];
  const runtime = { env: 'prod', hotVersion: 'hundred-lobby-http', configs: rows, registry, findConfig,
    gateway: { validateToken: async (token, uid) => token === 'token-' + uid,
      getLoginData: async uid => ({ agentId: uid === 2 ? 2 : 1 }) },
    wallet: { load() { throw new Error('hall cannot load a wallet'); } },
    log: { info() {}, error: (...args) => errors.push(args) } };
  const handler = await createHandler(runtime);
  const gameServer = http.createServer(), sockets = new WebSocketServer({ server: gameServer });
  sockets.on('connection', socket => {
    socket.on('message', raw => handler.onMessage(socket, raw).catch(error => errors.push(error)));
    socket.on('close', () => handler.onClose(socket).catch(error => errors.push(error)));
  });
  await new Promise(resolve => gameServer.listen(0, '127.0.0.1', resolve));
  const app = await createApp({ env: 'prod', hotVersion: runtime.hotVersion,
    config: { game_server: '127.0.0.1:1', hundred_server: '127.0.0.1:' + gameServer.address().port }, log: runtime.log,
    matchStore: { listMatches: () => [] }, roomStore: { list: () => rows } });
  const hall = http.createServer(app);
  await new Promise(resolve => hall.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await Promise.all([new Promise(resolve => gameServer.close(resolve)), new Promise(resolve => hall.close(resolve))]);
  });
  const query = async (uid = 1, token = 'token-' + uid) => (await fetch('http://127.0.0.1:' + hall.address().port
    + '/api/internal/v1/do?' + new URLSearchParams({ op: 38, gameType: 1001, userId: uid, token }))).json();
  assert.equal((await query(1, 'invalid')).msgCode, 401);
  const cold = await query();
  assert.equal(cold.msgCode, 200);
  assert.equal(cold.data[0].roomInfoData.length, 5);
  assert.equal(registry.tables.size, 0);
  const games = await loadGames(runtime.hotVersion), row = rows[0], game = gameOf(games, row.room_type);
  const table = game.createTable(row.game_room_config_id * 10000, row.room_type, row);
  registry.setTable(table.roomId, table, 1, game.id);
  game.engine.beginRound({ broadcast() {} }, table, Date.now());
  const live = (await query()).data[0].roomInfoData.find(item => item.roomType === row.room_type);
  assert.equal(live.gameStatus, 2);
  assert.ok(live.gameStatusDuration > 0);
  assert.equal(JSON.parse(live.extendInfo).defaultOuter.length, 24);
  assert.equal((await query(2)).data[0].roomInfoData.find(item => item.roomType === row.room_type).gameStatus, 0);
  table.state = 6;
  table.phaseEndsAt = Date.now() + 8000;
  table.ways[2].ways.push({ innerValue: 1, outerValue: 2 });
  const settled = (await query()).data[0].roomInfoData.find(item => item.roomType === row.room_type);
  assert.equal(settled.gameStatus, 6);
  assert.equal(JSON.parse(settled.extendInfo).ways[2].ways.at(-1), 2);
  assert.deepEqual(table.ways[2].ways.at(-1), { innerValue: 1, outerValue: 2 }, 'hall conversion preserves room roads');
  assert.equal(registry.tables.size, 1);
  assert.equal(registry.sessions.size, 0);
  assert.equal(table.people, 0);
  assert.deepEqual(errors, []);
});
