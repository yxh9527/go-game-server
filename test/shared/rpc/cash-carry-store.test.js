import test from 'node:test';
import assert from 'node:assert/strict';
import { createCashCarryStore, CARRY_SCRIPT, CARRY_TTL_MS } from '../../../shared/rpc/cash-carry-store.js';

test('cash lease commands use a scoped key, fixed five minute TTL, and fencing token', async () => {
  const calls = [];
  const redis = { async eval(...args) { calls.push(args); return args[3] === 'release' ? 'OK' : args[5]; } };
  const store = createCashCarryStore(redis), session = { agentId: 3, userId: 42, currency: 'CNY' };
  const record = { token: 'lease-a', tableKey: '3:holdem:700000', amount: 600, revision: 1 };
  await store.reserve(session, record);
  await store.update(session, { ...record, amount: 500, revision: 2 });
  await store.renew(session, record);
  await store.release(session, record);
  assert.deepEqual(calls.map(c => c[3]), ['reserve', 'update', 'renew', 'release']);
  assert.ok(calls.every(c => c[0] === CARRY_SCRIPT && c[1] === 1 && c[4] === 'lease-a'));
  assert.equal(calls[0][2], 'gogame:cash-carry:3:42:CNY');
  assert.equal(CARRY_TTL_MS, 300000);
  assert.match(CARRY_SCRIPT, /PEXPIRE/);
  await store.reserve({ ...session, agentId: 4 }, record);
  await store.reserve({ ...session, currency: 'USD' }, record);
  assert.equal(new Set(calls.map(c => c[2])).size, 3);
});

test('Redis read preserves the remaining TTL and never renews a lease', async t => {
  t.mock.method(Date, 'now', () => 1800000000000);
  const store = createCashCarryStore({ async eval(_script, _n, _key, action) {
    assert.equal(action, 'read');
    return JSON.stringify({ token: 'lease', tableKey: '3:holdem:1', amount: 500, ttlMs: 1234 });
  } });
  const record = await store.get({ agentId: 3, userId: 42 });
  assert.equal(record.expiresAt, Date.now() + 1234);
  assert.equal(record.amount, 500);
});

test('missing Redis and invalid records fail instead of simulating storage success', async () => {
  const session = { agentId: 3, userId: 42 };
  await assert.rejects(createCashCarryStore(null).get(session), { code: 'CARRY_STORE_UNAVAILABLE' });
  let calls = 0; const store = createCashCarryStore({ async eval() { calls++; } });
  await assert.rejects(store.reserve(session, { token: '', amount: 1 }), /token required/);
  await assert.rejects(store.reserve(session, { token: 'a', amount: -1, tableKey: 'x', revision: 1 }), /Invalid carry/);
  await assert.rejects(store.reserve(session, { token: 'a', amount: 1, tableKey: 'x', revision: 0 }), /Invalid carry/);
  await assert.rejects(store.get({ agentId: 3, userId: 0 }), /Invalid carry account/);
  assert.equal(calls, 0);
});
