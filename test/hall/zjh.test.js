import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoomLogic } from '../../hall/src/rooms.js';
import * as decode from '../../hall/src/decode.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import http from 'node:http';
import { handleLocalRequest } from '../../cache/game-server/http.js';
import { getDevHoldemRecordDetail } from '../../cache/hall/record-detail.js';

test('Zjh hall config matches ante, mode and buy-in, with the original five-part key', () => {
  const logic = createRoomLogic(decode), rows = seedRooms();
  const low = rows.find((r) => r.game_room_config_id === 2501);
  const high = rows.find(r => r.game_room_config_id === 16);
  const request = { gameType: 25, roomType: 25, playMode: 3, ante: 100, carryMin: 1000 };
  assert.equal(logic.findRoom(rows, request), high);
  assert.equal(logic.findRoom(rows, { ...request, ante: 10, carryMin: 100, playMode: 5 }).game_room_config_id, 2503);
  assert.equal(logic.findRoom(rows, { ...request, ante: 500, carryMin: 5000, roomClassification: 2 }), null);
  assert.equal(logic.findRoom(rows, { ...request, ante: 2000, carryMin: 1000 }), null);
  assert.equal(JSON.parse(low.payload).key, '25/3/10/2/100');
  assert.equal(logic.enterRoomPayload(low, {}, { game_server: 'localhost:11041' }).ante, 10);
  assert.equal(logic.enterRoomPayload(low, {}, {}).key, '25/3/10/2/100');
  assert.equal(logic.filterRooms(rows, { gameType: 21 })[0], low);
});

test('all nine Zjh lobby tiers route to their own configuration with matching keys', () => {
  const logic = createRoomLogic(decode), rows = seedRooms();
  const listed = logic.filterRooms(rows, { gameType: 21 });
  assert.deepEqual(listed.map(r => [r.game_room_config_id, r.play_mode, r.ante, r.carry_min]), [
    [2501, 3, 10, 100], [16, 3, 100, 1000], [17, 3, 500, 5000], [125, 3, 2000, 50000],
    [134, 2, 100, 1000], [73, 2, 500, 5000], [74, 2, 2000, 50000],
    [2503, 5, 10, 100], [2502, 5, 100, 1000],
  ]);
  const roomIds = new Set();
  for (const row of listed) {
    const payload = JSON.parse(row.payload);
    const found = logic.findRoom(rows, { ...payload, gameType: 25 });
    assert.equal(found, row);
    const enter = logic.enterRoomPayload(found, payload, {});
    assert.equal(enter.key, payload.key);
    assert.equal(enter.roomClassification, payload.roomClassification);
    roomIds.add(enter.roomId);
    // Formal schema stores classification in Payload rather than a column.
    const formalRow = { ...row }; delete formalRow.room_classification;
    assert.equal(logic.findRoom([formalRow], payload), formalRow);
    assert.equal(logic.enterRoomPayload(formalRow, {}, {}).key, payload.key);
  }
  assert.equal(roomIds.size, 9);
});

test('dev detail transport verifies token and trusted agent without joining or changing balances', async (t) => {
  let queried = 0;
  const detail = { exploitsInfoMsgs: [{ gameInningId: '25010000_1' }] };
  const runtime = { gateway: {
    validateToken: async (token, uid) => token === 'dev' && uid === 123,
    getLoginData: async () => ({ agentId: 7 }),
  }, getDevHoldemRecordDetail(room, inning, uid, agent) {
    assert.deepEqual([room, inning, uid, agent], [25010000, 1, 123, 7]);
    queried += 1; return detail;
  } };
  const server = http.createServer((req, res) => handleLocalRequest(runtime, req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const hall = { config: { game_server: '127.0.0.1:' + server.address().port } };
  assert.deepEqual(await getDevHoldemRecordDetail(hall, 25010000, 1, { userId: 123, token: 'dev' }), detail);
  assert.equal(await getDevHoldemRecordDetail(hall, 25010000, 1, { userId: 123, token: 'wrong' }), null);
  assert.equal(queried, 1);
});
