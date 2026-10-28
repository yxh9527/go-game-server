import assert from "node:assert/strict";
import test from "node:test";
import { seedRooms } from "../../cache/rpc/seed.js";
import { refreshRoomConfigs } from "../../cache/rpc/room-configs.js";
import { createRoomLogic } from "../../hall/src/rooms.js";
import * as decode from "../../hall/src/decode.js";

const rooms = createRoomLogic(decode);
test('no-show tiers have distinct keys and cannot select a forced-show or unsupported tier', () => {
  const rows = seedRooms();
  const selected = rooms.filterRooms(rows, { gameType: 19, playMode: 0, forceShowCard: false });
  assert.deepEqual(selected.map((r) => r.game_room_config_id), [1924, 1925, 1926]);
  const holdem = rows.filter((r) => r.room_type === 19);
  assert.equal(new Set(holdem.map((r) => JSON.parse(r.payload).key)).size, holdem.length);
  for (const row of selected) {
    const payload = JSON.parse(row.payload);
    const found = rooms.findRoom(rows, payload);
    assert.equal(found.game_room_config_id, row.game_room_config_id);
    const enter = rooms.enterRoomPayload(found, { ...payload, carryMin: 0 }, {});
    assert.equal(enter.key, payload.key);
    assert.equal(enter.carryMin, row.carry_min);
    assert.equal(enter.forceShowCard, false);
  }
  for (const params of [
    { gameRoomConfigId: 70, forceShowCard: false },
    { roomType: 19, forceShowCard: false, playMode: 7 },
    { roomType: 19, forceShowCard: false, smallBlind: 123, bigBlind: 456 },
    { gameRoomConfigId: 99999 },
  ]) assert.equal(rooms.findRoom(rows, params), null);
});

test('dev seed adoption refreshes configs without replacing runtime tables or wallet', async (t) => {
  const storedWallet = { value: 8765 };
  const table = { roomId: 700000, createdAt: 42, hand: { pot: 100 }, history: [{ inning: 1 }] };
  const store = { listRooms: async () => [] };
  const runtime = { rpc: { lobby: { store } }, configs: [], wallet: storedWallet, tables: [table],
    roomStore: { replace(rows) { this.rows = rows; } } };
  await refreshRoomConfigs(runtime);
  t.after(() => runtime.devRoomConfigWatcher.close());
  const watcher = runtime.devRoomConfigWatcher;
  await refreshRoomConfigs(runtime);
  assert.equal(runtime.devRoomConfigWatcher, watcher);
  assert.equal(runtime.configs.filter((r) => r.room_type === 19).length, 19);
  assert.equal(runtime.roomStore.rows.length, (await store.listRooms()).length);
  assert.equal(runtime.wallet, storedWallet);
  assert.equal(runtime.tables[0], table);
  assert.equal(table.createdAt, 42);
  const rows = await store.listRooms();
  rows[0].carry_min = -1;
  assert.equal((await store.listRooms())[0].carry_min, 500);
});
