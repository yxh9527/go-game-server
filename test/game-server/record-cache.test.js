import assert from "node:assert/strict";
import test from "node:test";
import { getCachedRecordDetail, getCachedRecords } from "../../game-server/src/record-cache.js";

function memoryBus() {
  const cache = new Map();
  return {
    cache,
    async getCache(key) { return cache.get(key) ?? null; },
    async setCache(key, value, ttl) { cache.set(key, value); assert.ok(ttl > 0); },
  };
}

test("record list cache scopes by user and sends ES query only through data-center gateway", async () => {
  const bus = memoryBus();
  const calls = [];
  const gateway = { async getRecords(query) { calls.push(query); return { total: 1, data: [{ roundID: "r1" }] }; } };
  const query = { gameId: 19, page: 1, size: 20 };
  const first = await getCachedRecords({ gateway, bus, userId: 7, query });
  const hit = await getCachedRecords({ gateway, bus, userId: 7, query });
  await getCachedRecords({ gateway, bus, userId: 8, query });
  assert.deepEqual(hit, first);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].userId, 7);
  assert.equal(calls[0].size, 20);
});

test("record detail cache includes user, game and record id", async () => {
  const bus = memoryBus();
  const calls = [];
  const gateway = { async getRecordDetail(query) { calls.push(query); return { found: true, data: { roundID: query.recordId } }; } };
  await getCachedRecordDetail({ gateway, bus, userId: 7, gameId: 19, recordId: "round-1" });
  await getCachedRecordDetail({ gateway, bus, userId: 7, gameId: 19, recordId: "round-1" });
  await getCachedRecordDetail({ gateway, bus, userId: 7, gameId: 20, recordId: "round-1" });
  assert.equal(calls.length, 2);
  await assert.rejects(getCachedRecordDetail({ gateway, bus, userId: 0, recordId: "x" }));
});
