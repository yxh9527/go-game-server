import test from 'node:test';
import assert from 'node:assert/strict';
import { createWallet, createRpcWallet } from '../../../game-server/src/wallet/index.js';
import { CARRY_TTL_MS, cashTableKey } from '../../../game-server/src/wallet/carry.js';
import { SeatGame } from '../../../game-server/src/core/SeatGame.js';

const table = roomId => ({ agentId: 5, gameId: 'holdem', kind: 'normal', roomType: 19, roomId });
async function fixture() {
  const wallet = createWallet({ mode: 'local', local_balance: 1000 });
  const a = { agentId: 5, userId: 9101 }, b = { agentId: 5, userId: 9101 };
  await Promise.all([wallet.load(a), wallet.load(b)]);
  return { wallet, a, b, member: { uid: a.userId, point: 0 }, table: table(700000) };
}

test('carry and extra carry reserve funds without reducing balance; wagers mirror wallet and carry', async () => {
  const f = await fixture();
  assert.equal(f.wallet.reserveCarry(f.a, f.member, f.table, 600).ok, true);
  assert.equal(f.a.wallet, 1000);
  assert.equal(f.a.carryAmount, 600);
  assert.equal(f.b.availableBalance, 400);
  f.wallet.reserveCarry(f.a, f.member, f.table, 100);
  assert.equal(f.member.point, 700);
  assert.equal(f.a.wallet, 1000);
  f.member.point -= 200;
  assert.equal(f.a.wallet, 800);
  assert.equal(f.b.carryAmount, 500);
  assert.equal(f.b.availableBalance, 300);
  f.member.point += 350;
  assert.equal(f.a.wallet, 1150);
  assert.equal(f.a.carryAmount, 850);
  assert.equal(f.a.availableBalance, 300);
  f.wallet.releaseCarry(f.a, f.member);
  f.wallet.releaseCarry(f.a, f.member);
  assert.equal(f.a.wallet, 1150);
  assert.equal(f.b.carryAmount, 0);
  assert.equal(f.a.availableBalance, 1150);
});

test('all non-seat purchases and multi-table wagers can spend only balance minus carry', async () => {
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 800);
  const results = await Promise.all([Promise.resolve().then(() => f.wallet.debit(f.a, 150)),
    Promise.resolve().then(() => f.wallet.debit(f.b, 150))]);
  assert.deepEqual(results.map(r => r.ok), [true, false]);
  assert.equal(f.a.wallet, 850);
  assert.equal(f.member.point, 800);
  assert.equal(f.b.availableBalance, 50);
  assert.equal(f.wallet.reserveCarry(f.b, f.member, f.table, 51).ok, false);
  assert.equal(f.wallet.reserveCarry(f.b, f.member, f.table, 50).ok, true);
  assert.equal(f.a.carryAmount, 850);
  assert.equal(f.a.wallet, 850);
});

test('one account can own only one funded seat, while another agent is independent', async () => {
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 500);
  assert.throws(() => f.wallet.assertCashEntry(f.b, table(700001)), { code: 'CARRY_CONFLICT' });
  assert.equal(f.wallet.assertCashEntry(f.b, f.table).tableKey, cashTableKey(f.table));
  assert.throws(() => f.wallet.reserveCarry(f.b, { point: 0 }, table(700001), 100), { code: 'CARRY_CONFLICT' });
  assert.throws(() => f.wallet.reserveCarry(f.b, { point: 0 }, f.table, 100), { code: 'CARRY_CONFLICT' });
  const other = { agentId: 6, userId: f.a.userId };
  await f.wallet.load(other);
  assert.equal(f.wallet.reserveCarry(other, { point: 0 }, { ...f.table, agentId: 6 }, 1000).ok, true);
});

test('lease changes renew five minutes; expiry fences the old seat and cannot delete a new lease', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 600);
  assert.equal(f.wallet.carryRecord(f.a).expiresAt, now + CARRY_TTL_MS);
  now += 200000;
  f.member.point -= 100;
  assert.equal(f.wallet.carryRecord(f.a).expiresAt, now + CARRY_TTL_MS);
  now += CARRY_TTL_MS;
  assert.equal(f.wallet.carryRecord(f.a), null);
  assert.equal(f.a.wallet, 900);
  assert.equal(f.a.availableBalance, 900);
  const replacement = { point: 0 };
  f.wallet.reserveCarry(f.b, replacement, table(700001), 700);
  assert.throws(() => { f.member.point += 1; }, { code: 'CARRY_CONFLICT' });
  f.wallet.releaseCarry(f.a, f.member);
  assert.equal(f.b.carryAmount, 700);
  assert.equal(f.b.wallet, 900);
});

test('a zero stack remains owned until settlement/release and active heartbeat prevents idle expiry', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 100);
  f.member.point = 0;
  assert.equal(f.a.wallet, 900);
  assert.throws(() => f.wallet.assertCashEntry(f.a, table(700001)), { code: 'CARRY_CONFLICT' });
  for (let i = 0; i < 12; i++) { now += 60000; f.wallet.renewCarry(f.member); }
  assert.ok(f.wallet.carryRecord(f.a));
  f.wallet.releaseCarry(f.a, f.member);
  assert.equal(f.wallet.carryRecord(f.a), null);
});

test('partial carry-out unlocks only the requested reservation and never credits money', async () => {
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 700);
  f.wallet.releaseCarry(f.a, f.member, 200);
  assert.equal(f.member.point, 500);
  assert.equal(f.a.wallet, 1000);
  assert.equal(f.a.availableBalance, 500);
});

test('RPC wallet replacement retains the same carry across hot updates and fresh connections', async () => {
  let balance = 1000;
  const rpc = { common: { async getBalance() { return balance; },
    debit(_uid, amount) { balance -= amount; return { ok: true, balance }; },
    credit(_uid, amount) { balance += amount; return { ok: true, balance }; } } };
  const a = { agentId: 5, userId: 42 }, b = { agentId: 5, userId: 42 }, member = { point: 0 };
  const before = createRpcWallet(rpc);
  await before.load(a);
  before.reserveCarry(a, member, table(700000), 600);
  const { createRpcWallet: updated } = await import('../../../game-server/src/wallet/rpcWallet.js?v=carry-test');
  const after = updated(rpc);
  await after.load(b);
  assert.equal(b.carryAmount, 600);
  assert.equal(after.debit(b, 401).ok, false);
  member.point -= 100;
  assert.equal(b.wallet, 900);
  assert.equal(b.carryAmount, 500);
});

test('expired table guards pause old actions without expiring financial results or modifying balance', async t => {
  let now = 1800000000000;
  t.mock.method(Date, 'now', () => now);
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 500);
  f.table.members = [f.member]; f.table.hand = { journal: { unsettled: true } };
  now += CARRY_TTL_MS;
  assert.throws(() => f.wallet.guardCashTable(f.table), { code: 'CARRY_CONFLICT' });
  assert.ok(f.table.carryFault);
  assert.equal(f.table.hand.journal.unsettled, true);
  assert.equal(f.a.wallet, 1000);
});

test('folded departures retain a zero carry owner until their pending payout is settled', async () => {
  const f = await fixture();
  f.wallet.reserveCarry(f.a, f.member, f.table, 500);
  f.member.point -= 100;
  f.table.hand = { statsPlayers: [f.member] };
  f.table.members = [];
  f.wallet.releaseCarry(f.a, f.member, f.member.point, true);
  assert.equal(f.member.point, 0);
  assert.equal(f.a.wallet, 900);
  assert.throws(() => f.wallet.assertCashEntry(f.a, table(700001)), { code: 'CARRY_CONFLICT' });
  f.wallet.guardCashTable(f.table);
  f.member.point += 100;
  assert.equal(f.a.wallet, 1000);
  f.table.hand = null; f.table.phase = 'starting';
  f.wallet.releaseFinishedCarries(f.table);
  assert.equal(f.a.wallet, 1000);
  assert.equal(f.a.carryAmount, 0);
  assert.equal(f.wallet.assertCashEntry(f.a, table(700001)), null);
});
