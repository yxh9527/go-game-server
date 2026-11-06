import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../hall/src/create-app.js';
import { createRoomLogic } from '../../hall/src/rooms.js';
import * as decode from '../../hall/src/decode.js';
import { seedRooms } from '../../cache/rpc/seed.js';

test('native in-game list gets a positive club context, actual tiers and usable switch endpoints', async () => {
  const rows = seedRooms();
  const app = await createApp({ env: 'dev', hotVersion: 'room-change-hall', config: {},
    gateway: { async authenticate(token, uid) { return { success: token === 'good', userId: uid }; },
      async getLoginData(uid) { return { userId: uid, userName: 'test-player', agentId: 7 }; } },
    rpc: { common: { async getBalance() { return 10000; } }, lobby: { async countUnusedTickets() { return 0; } } },
    log: { error() {} }, roomStore: { list: () => rows }, matchStore: { listMatches: () => [] } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = async (op, params = {}, token = 'good') => {
    const query = new URLSearchParams({ op, userId: '7721', token,
      param: Buffer.from(new URLSearchParams(params).toString()).toString('base64') });
    return (await fetch(`http://127.0.0.1:${server.address().port}/internal/v1/do?${query}`)).json();
  };
  try {
    const info = await request(49, { clubId: 0, type: 1, roomType: 19, isGameList: true });
    assert.equal(info.msgCode, 200); assert.equal(info.data.clubId, 7);
    const login = await request(53, { clubId: 0 });
    assert.equal(login.data.clubId, 7); assert.equal(login.data.userId, 7721);
    assert.equal((await request(49, { clubId: 0 }, 'bad')).msgCode, 401);
    for (const [gameType, params] of [[19, { forceShowCard: 1 }], [21, {}], [20, {}], [27, {}], [31, {}], [32, {}]]) {
      const response = await request(38, { gameType, ...params });
      assert.equal(response.msgCode, 200);
      assert.ok(response.data[0].roomInfoData.length > 0);
      assert.ok(response.data[0].roomInfoData.every(room => Number.isInteger(room.gameRoomConfigId) && room.carryMin >= 0));
    }
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  const rooms = createRoomLogic(decode);
  for (const type of [19, 25, 24, 27, 31, 32, 26, 28, 30, 61, 63]) {
    const row = rows.find(row => row.room_type === type);
    const payload = rooms.enterRoomPayload(row, {}, { game_server: 'www.localhost:11042' });
    assert.ok(payload.domain); assert.ok(payload.shield);
  }
});

test('Hundred all-modes field lists accept the native serialized undefined mode without losing peek tables', () => {
  const rooms = createRoomLogic(decode), rows = seedRooms();
  for (const gameType of [1002, 1003]) {
    const all = rooms.filterRooms(rows, { gameType });
    for (const playMode of [undefined, null, '', 'undefined', 'null']) {
      assert.deepEqual(rooms.filterRooms(rows, { gameType, playMode }), all);
    }
    assert.ok(rooms.filterRooms(rows, { gameType, playMode: 1 }).every(row => row.play_mode === 1));
    assert.ok(rooms.filterRooms(rows, { gameType, playMode: '0' }).every(row => row.play_mode === 0));
  }
});
