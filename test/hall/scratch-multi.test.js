import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomLogic } from '../../hall/src/rooms.js';
import * as decode from '../../hall/src/decode.js';
import { seedRooms } from '../../cache/rpc/seed.js';

test('scratch multi panel reuses its open main socket while hundred overlays retain their separate endpoint', () => {
  const rooms = createRoomLogic(decode), config = { game_server: 'www.localhost:11042', hundred_server: 'hundred.localhost:11042' };
  for (const type of [61, 63]) {
    const row = seedRooms().find(row => row.room_type === type);
    const payload = rooms.enterRoomPayload(row, {}, config);
    assert.equal(payload.hundredDomain, payload.domain);
  }
  const row = seedRooms().find(row => row.room_type === 19);
  assert.equal(rooms.enterRoomPayload(row, {}, config).hundredDomain, config.hundred_server);
});
