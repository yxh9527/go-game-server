import test from 'node:test';
import assert from 'node:assert/strict';
import { settleCardBets } from '../../../game-server/src/core/hundred-card-payout.js';

function fixture() {
  const session = { userId: 17, agentId: 3, wallet: 900 };
  const table = { agentId: 3, roomId: 580001, roomType: 58, inning: 1,
    lastResult: { areas: [1] }, playerSessions: new Map([[17, session]]),
    playerBets: new Map([[17, [{ areaId: 1, total: 100 }]]]), visitors: new Set([17]) };
  let records = 0;
  const io = { wallet: { credit(s, amount) { s.wallet += amount; return { ok: true }; }, async persist() {} },
    forEachPlayer(fn) { fn(session); }, sendUser() {} };
  const adapter = { calculate: () => ({ payout: 200, realScore: 100, areaWinningScores: { 1: 100 } }),
    snapshot: () => ({}), resultPayload: () => ({}), record() { records++; }, bankerAreas: [[1], [2]] };
  return { session, table, io, adapter, records: () => records };
}

test('concurrent card payouts share a resident task across module versions', async () => {
  const f = fixture();
  let release, started, credits = 0;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.io.wallet.credit = async (session, amount) => { credits++; started(); await gate; session.wallet += amount; return { ok: true }; };
  const first = settleCardBets(f.io, f.table, f.adapter);
  await began;
  const next = await import('../../../game-server/src/core/hundred-card-payout.js?v=payout-concurrency');
  const second = next.settleCardBets(f.io, f.table, f.adapter);
  assert.equal(first, second);
  release(); await Promise.all([first, second]);
  await next.settleCardBets(f.io, f.table, f.adapter);
  assert.equal(credits, 1);
  assert.equal(f.session.wallet, 1100);
  assert.equal(f.records(), 1);
});

test('a failed save after credit retries the save without repeating card winnings', async () => {
  const f = fixture();
  let saves = 0, credits = 0;
  f.io.wallet.credit = (session, amount) => { credits++; session.wallet += amount; return { ok: true }; };
  f.io.wallet.persist = async () => { if (++saves === 1) throw new Error('save unavailable'); };
  await assert.rejects(settleCardBets(f.io, f.table, f.adapter), /save unavailable/);
  const next = await import('../../../game-server/src/core/hundred-card-payout.js?v=payout-save-retry');
  await next.settleCardBets(f.io, f.table, f.adapter);
  assert.equal(credits, 1);
  assert.equal(saves, 2);
  assert.equal(f.records(), 1);
  assert.equal(f.table.lastResult.settled, true);
});
