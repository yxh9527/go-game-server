import assert from "node:assert/strict";
import test from "node:test";
import { createRegistry } from "../../game-server/src/registry.js";

test("room registry isolates identical room ids by agent and indexes by game", () => {
  const registry = createRegistry();
  const a = { roomId: 19, agentId: 3, gameId: 1, roomType: 19 };
  const b = { roomId: 19, agentId: 4, gameId: 1, roomType: 19 };
  registry.setTable(a.roomId, a);
  registry.setTable(b.roomId, b);

  assert.equal(registry.getTable(19, 3), a);
  assert.equal(registry.getTable(19, 4), b);
  assert.deepEqual(registry.listAgentGameRooms(3, 1), [a]);
  assert.deepEqual(registry.listAgentGameRooms(4, 1), [b]);

  registry.removeTable(19, 3);
  assert.equal(registry.getTable(19, 3), null);
  assert.equal(registry.getTable(19, 4), b);
});
