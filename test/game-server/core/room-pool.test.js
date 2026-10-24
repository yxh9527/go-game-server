import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../../../game-server/src/registry.js";
import { HoldemGame } from "../../../game-server/src/games/holdem/HoldemGame.js";
import { ZjhGame } from "../../../game-server/src/games/zjh/ZjhGame.js";
import { createRoomPool } from "../../../game-server/src/core/room-pool.js";
import { ROOM_LIFETIME_MS, capacitySnapshot, expansionCount, initializeLifetime, isExpired } from "../../../game-server/src/core/room-lifecycle.js";

function fixture() {
  const registry = createRegistry();
  const game = new HoldemGame();
  const pool = createRoomPool({ registry }, () => game);
  const cfg = { game_room_config_id: 70, room_type: 19, play_mode: 0, room_index: 0 };
  const fill = (table, count = 7) => {
    table.members = Array.from({ length: count }, (_, pos) => ({ uid: table.roomId * 10 + pos, pos, point: 100, bot: pos > 0 }));
  };
  return { registry, game, pool, cfg, fill };
}

test("room clocks survive emptiness, legacy retirement flags and hot reload", async () => {
  const table = { createdAt: 1000, retireWhenHandEnds: true, retired: true };
  initializeLifetime(table, 5000);
  assert.equal(table.expiresAt, 1000 + ROOM_LIFETIME_MS);
  assert.equal(table.retired, undefined);
  assert.equal(table.retireWhenHandEnds, undefined);
  assert.equal(isExpired(table, table.expiresAt - 1), false);
  const reloaded = await import("../../../game-server/src/core/room-lifecycle.js?v=clock-test");
  reloaded.initializeLifetime(table, 9000);
  assert.equal(table.createdAt, 1000);
  assert.equal(reloaded.isExpired(table, table.expiresAt), true);
});

test("80 percent means full rooms, not the percentage of occupied chairs", () => {
  const tables = Array.from({ length: 5 }, () => ({ members: Array.from({ length: 6 }, (_, pos) => ({ pos })) }));
  assert.equal(capacitySnapshot(tables, () => 7).occupied, 30);
  assert.equal(expansionCount(tables, () => 7), 0, "30/35 occupied but no full room");
  for (let n = 0; n < 4; n += 1) tables[n].members.push({ pos: 6 });
  assert.equal(capacitySnapshot(tables, () => 7).fullRooms, 4);
  assert.equal(expansionCount(tables, () => 7), 1);
  const hundred = Array.from({ length: 100 }, (_, n) => n < 80 ? tables[0] : { members: [] });
  assert.equal(expansionCount(hundred, () => 7), 5);
  assert.equal(expansionCount(hundred.slice(0, 21), () => 7), 2, "ceil(21 * 5%)");
});

test("expansion creates empty standby rooms without resetting existing lifetimes", () => {
  const { pool, cfg, fill, registry } = fixture();
  for (let n = 0; n < 5; n += 1) {
    const table = pool.create(700000 + n, 19, 1, cfg, false, 1000);
    fill(table, n < 4 ? 7 : 0);
  }
  const created = pool.expand(2000);
  assert.equal(created.length, 1);
  assert.equal(created[0].roomId, 700005);
  assert.deepEqual(created[0].members, []);
  assert.deepEqual(created[0].observers, []);
  assert.equal(created[0].phase, "idle");
  assert.equal(created[0].standby, true);
  assert.equal(created[0].expiresAt, 2000 + ROOM_LIFETIME_MS);
  assert.equal(registry.getTable(700000, 1, "holdem").createdAt, 1000);
  assert.equal(pool.expand(3000).length, 0, "empty reserves lower the full-room ratio");
});

test("room pools stay separate by agent and configuration and skip expired rooms", () => {
  const { pool, cfg, fill } = fixture();
  fill(pool.create(700000, 19, 1, cfg, false, 1000));
  pool.create(700000, 19, 2, cfg, false, 1000);
  pool.create(710000, 19, 1, { ...cfg, game_room_config_id: 71 }, false, 1000);
  const created = pool.expand(2000);
  assert.equal(created.length, 1);
  assert.equal(created[0].agentId, 1);
  assert.equal(created[0].cfg.game_room_config_id, 70);
  assert.equal(pool.expand(2000 + ROOM_LIFETIME_MS).length, 0);
  assert.deepEqual(pool.list(1, 2000 + ROOM_LIFETIME_MS), []);
});

test("allocation reuses standby rooms and never revives an expired room identity", async () => {
  const { pool, cfg, fill, registry, game } = fixture();
  const first = pool.allocate(1, cfg, 0, 1000);
  const table = registry.getTable(first.roomId, 1, "holdem");
  assert.deepEqual(table.members, []);
  assert.equal(pool.allocate(1, cfg, 0, 1500).roomId, first.roomId);
  fill(table);
  const reserve = pool.expand(2000)[0];
  assert.equal(pool.allocate(1, cfg, 0, 2000).roomId, reserve.roomId);
  registry.removeTable(table.roomId, 1, "holdem");
  registry.removeTable(reserve.roomId, 1, "holdem");
  const reloaded = await import("../../../game-server/src/core/room-pool.js?v=sequence-test");
  const next = reloaded.createRoomPool({ registry }, () => game).allocate(1, cfg, 0, 3000);
  assert.equal(next.roomId, 700002);
  assert.equal(next.expiresAt, 3000 + ROOM_LIFETIME_MS);
});

test("allocation groups by the game's effective default play mode", () => {
  const registry = createRegistry();
  const game = new ZjhGame();
  const pool = createRoomPool({ registry }, () => game);
  const cfg = { game_room_config_id: 71, room_type: 25, play_mode: 0 };
  const first = pool.allocate(1, cfg, 0);
  assert.equal(first.playMode, 3);
  assert.equal(pool.allocate(1, cfg, 0).roomId, first.roomId);
  assert.equal(registry.tables.size, 1);
});

test("exhausted configuration indexes do not interrupt expansion of other pools", () => {
  const { pool, cfg, fill, registry, game } = fixture();
  fill(pool.create(709999, 19, 1, cfg));
  fill(pool.create(710000, 19, 1, { ...cfg, game_room_config_id: 71 }));
  const errors = [];
  const next = createRoomPool({ registry, log: { error: (...args) => errors.push(args) } }, () => game);
  const created = next.expand();
  assert.deepEqual(created.map((table) => table.roomId), [710001]);
  assert.equal(errors.length, 1);
});
