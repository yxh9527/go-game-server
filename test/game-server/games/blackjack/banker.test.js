import test from 'node:test';
import assert from 'node:assert/strict';
import { BlackjackGame } from '../../../../game-server/src/games/blackjack/BlackjackGame.js';
import * as banker from '../../../../game-server/src/games/blackjack/banker.js';
import * as engine from '../../../../game-server/src/games/blackjack/engine.js';
import { STATE, SEND } from '../../../../game-server/src/games/blackjack/messages.js';
import { makeShoe } from '../../../../game-server/src/games/blackjack/hand.js';
import { prepareClosure } from '../../../../game-server/src/core/room-lifecycle.js';

function fixture() {
  const game = new BlackjackGame(), table = game.createTable(31100000, 31, { play_mode: 1, ante: 100 });
  const sessions = new Map(), messages = [];
  const io = { broadcast(id, data) { messages.push({ id, data: structuredClone(data) }); },
    sendUser(uid, id, data) { messages.push({ uid, id, data: structuredClone(data) }); },
    sessionFor: uid => sessions.get(uid), forEachPlayer: fn => [...sessions.values()].forEach(fn) };
  const ctx = uid => {
    if (!sessions.has(uid)) sessions.set(uid, { userId: uid, name: 'banker-' + uid, icon: '/avatar/' + uid, wallet: 100000 });
    return { game, table, io, session: sessions.get(uid), send: (id, data) => io.sendUser(uid, id, data) };
  };
  const request = (uid, id, body) => game.onMessage(ctx(uid), id, body);
  const apply = (uid = 1, type = 1, amount = 20000, limit = 10000) => request(uid, 4509, { bankerType: type, amount, maxWinLoseAmount: limit, bankerCount: 10 });
  const boundary = async () => { table.phase = 'starting'; table.startAt = 0; await game.afterRound(ctx(1)); };
  return { game, table, sessions, messages, io, ctx, request, apply, boundary };
}
const entry = (f, uid = 1, type = 1) => f.table.casinoBankers.entries.find(e => e.uid === uid && e.bankerType === type);
const last = (f, id) => f.messages.findLast(m => m.id === id)?.data;
function finish(f) { for (let i = 0; i < 100 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline); assert.ok(f.table.hand.settled); }
function cleanup(f) { engine.tick(f.io, f.table, f.table.hand.deadline); assert.equal(f.table.hand, null); }
function wager(f, deck) {
  const c = f.ctx(2); f.game.onSitDown({ ...c, body: { position: 1 } });
  engine.begin(f.io, f.table, 1000, [...deck, ...makeShoe()]);
  assert.ok(engine.act(f.io, f.table, 2, SEND.BET, { betAmount: 100 }, 1001));
}

test('native apply queues without debit; limits, duplicate, ordinary and robots follow original response codes', () => {
  const f = fixture(); f.apply();
  assert.equal(last(f, 4558).code, 0); assert.equal(f.ctx(1).session.wallet, 100000);
  assert.equal(entry(f).onBanker, false);
  assert.equal(last(f, 4561).normalBankerDataList[0].uid, 1, 'actual original findSelf needs uid despite bundled readMe');
  f.apply(); assert.equal(last(f, 4558).code, 2);
  f.apply(2, 1, 10001); assert.equal(last(f, 4558).code, 3);
  f.apply(2, 1, 200000); assert.equal(last(f, 4558).code, 4);
  f.request(1, 4510, { bankerType: 1 }); assert.equal(last(f, 4559).code, 3);
  assert.equal(f.table.casinoBankers.entries.length, 0);
  const ordinary = f.game.createTable(31010000, 31, { play_mode: 0 });
  const count = f.messages.length; f.game.onMessage({ ...f.ctx(1), table: ordinary }, 4509, {});
  assert.equal(f.messages.length, count + 1); assert.equal(last(f, 9999).errorMsg, '当前玩法不支持上庄');
  f.ctx(1).session.bot = true; f.apply(); assert.equal(last(f, 9999).errorMsg, '当前玩法不支持上庄');
});

test('each area has ten places and both-area queued applications debit only at the next boundary', async () => {
  const f = fixture(); for (let i = 1; i <= 10; i++) f.apply(i);
  f.apply(11); assert.equal(last(f, 4558).code, 1);
  f.apply(1, 2); assert.equal(last(f, 4558).code, 0);
  await f.boundary();
  assert.equal(f.ctx(1).session.wallet, 60000);
  assert.equal(entry(f, 1, 1).onBanker, true); assert.equal(entry(f, 1, 2).onBanker, true);
  f.apply(11, 2); assert.equal(last(f, 4558).code, 0);
  f.apply(1, 2); assert.equal(last(f, 4558).code, 2);
  f.game.onSitDown({ ...f.ctx(1), body: { position: 1 } });
  assert.equal(f.table.members.length, 0);
  await f.game.afterRound(f.ctx(1)); assert.equal(entry(f, 11, 2).onBanker, true, 'new applications invalidate an already prepared boundary');
});

test('current bettors can queue and continue playing; next hand returns seat escrow before entering banker role', async () => {
  const f = fixture(); wager(f, [9, 6, 8, 7]);
  f.apply(2); assert.equal(last(f, 4558).code, 0);
  assert.equal(f.ctx(2).session.wallet, 99900); assert.equal(entry(f, 2).onBanker, false);
  await f.game.afterRound(f.ctx(2)); assert.equal(entry(f, 2).onBanker, false);
  finish(f); const total = f.ctx(2).session.wallet + f.table.members[0].point; cleanup(f);
  await f.boundary();
  assert.equal(f.table.members.some(m => m.uid === 2), false);
  assert.equal(f.ctx(2).session.wallet + entry(f, 2).amount, total);
  assert.ok(f.messages.some(m => m.id === 3436 && m.data === 2));
  assert.equal(f.messages.some(m => m.id === 2204), false);
});

test('normal and insurance bankers receive native personalized settlement, conserve funds and cannot exceed their caps', async () => {
  for (const deck of [[9, 6, 0, 9], [9, 9, 8, 7], [0, 9, 7, 6]]) {
    const insurance = deck[0] === 0;
    const f = fixture(); f.apply(); f.apply(1, 2); f.apply(3); await f.boundary();
    wager(f, deck);
    engine.tick(f.io, f.table, f.table.hand.deadline);
    if (insurance) {
      engine.tick(f.io, f.table, f.table.hand.deadline);
      assert.equal(f.table.hand.state, STATE.INSURANCE);
      engine.act(f.io, f.table, 2, SEND.INSURANCE, { buyInsurance: true }, f.table.hand.deadline - 1);
    }
    finish(f);
    const settlements = f.messages.filter(m => m.id === 4562);
    assert.equal(settlements.length, 2); assert.equal(settlements.find(m => m.uid === 1).data.areas.length, 2);
    const banks = f.table.casinoBankers.entries;
    assert.equal([...f.sessions.values()].reduce((n, s) => n + s.wallet, 0) + f.table.members.reduce((n, m) => n + m.point, 0) + banks.reduce((n, e) => n + e.amount, 0) + f.table.houseNetScore, 300000);
    assert.ok(f.table.hand.bankers.every(b => Math.abs(b.score) <= b.cap));
    const replay = engine.historyPayload(f.table, {}, 2);
    const banksByArea = replay.gameBackInfo.bankerSettles[0];
    for (const [type, key] of [[1, 'normal'], [2, 'special']]) {
      const expected = f.table.hand.bankers.filter(b => b.bankerType === type).map(b => ({
        uid: b.uid, name: b.entry.name, icon: b.entry.icon, proportion: b.entry.proportion, score: b.score,
      }));
      assert.deepEqual(banksByArea[key].bankers, expected);
      assert.ok(expected.every(b => b.name && b.icon && Number.isFinite(b.proportion) && Number.isFinite(b.score)));
    }
    const saved = structuredClone(banksByArea);
    f.table.hand.bankers.forEach(b => { b.entry.proportion = 12.34; });
    banksByArea.normal.bankers[0].score = 99999;
    assert.deepEqual(engine.historyPayload(f.table, {}, 2).gameBackInfo.bankerSettles[0], saved);
    assert.equal(f.table.roomFeatures.players.get(1).totalHands, 1, 'two areas count as one participating hand');
    assert.equal(f.table.roomFeatures.players.get(1).winLostScore, settlements.find(m => m.uid === 1).data.score);
    assert.ok(f.messages.findIndex(m => m.id === 4551) < f.messages.findIndex(m => m.id === 4562));
    const count = settlements.length; engine.settle(f.io, f.table); assert.equal(f.messages.filter(m => m.id === 4562).length, count);
  }
});

test('re-entry restores banker identity and only cancels an exit scheduled by disconnection', async () => {
  for (const explicit of [false, true]) {
    const f = fixture(); f.apply(); await f.boundary(); wager(f, [9, 6, 0, 9]);
    if (explicit) f.request(1, 4510, { bankerType: 1 });
    f.game.onLeave(f.ctx(1));
    const reconnect = { ...f.ctx(1).session };
    f.game.onJoin({ ...f.ctx(1), session: reconnect });
    assert.equal(entry(f).pendingCancel, explicit);
    assert.equal(entry(f).session, reconnect);
    f.game.onLoginRoom({ ...f.ctx(1), session: reconnect });
    assert.equal(last(f, 4561).normalBankerDataList[0].uid, 1);
    assert.equal(last(f, 4561).normalBankerDataList[0].onBanker, true);
  }
});

test('queued edits do not debit, oversized boundary adjustments retain original capital, and reductions return the exact delta', async () => {
  const f = fixture(); f.apply();
  f.request(1, 4511, { bankerType: 1, amount: 30000, maxWinLoseAmount: 20000, bankerCount: 20 });
  assert.equal(last(f, 4560).code, 5); assert.equal(f.ctx(1).session.wallet, 100000);
  await f.boundary(); assert.equal(f.ctx(1).session.wallet, 70000);
  wager(f, [9, 6, 8, 7]);
  f.request(1, 4511, { bankerType: 1, amount: 50000, maxWinLoseAmount: 30000 });
  f.ctx(1).session.wallet = 0; finish(f); cleanup(f); await f.boundary();
  assert.equal(entry(f).amount, 30000); assert.equal(entry(f).maxWinLoseAmount, 20000);
  assert.equal(last(f, 9999).msgCode, 100113);
  f.request(1, 4511, { bankerType: 1, amount: 20000, maxWinLoseAmount: 10000 });
  assert.equal(last(f, 4560).code, 6); await f.boundary();
  assert.equal(entry(f).amount, 20000); assert.equal(f.ctx(1).session.wallet, 10000);
  assert.equal(last(f, 3680).carryOutAmount, 10000);
});

test('on-banker changes wait until boundary and cancellation retains current-hand liability', async () => {
  const f = fixture(); f.apply(); await f.boundary(); wager(f, [9, 6, 8, 7]);
  f.request(1, 4511, { bankerType: 1, amount: 30000, maxWinLoseAmount: 20000, bankerCount: 20 });
  assert.equal(last(f, 4560).code, 6); assert.equal(entry(f).amount, 20000);
  assert.equal(f.ctx(1).session.wallet, 80000);
  finish(f); cleanup(f); await f.boundary();
  assert.equal(entry(f).amount, 30000); assert.equal(entry(f).bankerCount, 20);
  assert.equal(f.ctx(1).session.wallet + entry(f).amount + f.table.roomFeatures.players.get(2).winLostScore + f.table.houseNetScore, 100000);
  engine.begin(f.io, f.table); f.request(1, 4510, { bankerType: 1 });
  assert.equal(last(f, 4559).code, 2);
  f.request(1, 4510, { bankerType: 1 }); assert.equal(last(f, 4559).code, 4);
  await f.game.afterRound(f.ctx(1)); assert.ok(entry(f).onBanker);
  finish(f); const deposit = entry(f).amount; cleanup(f);
  const before = f.ctx(1).session.wallet; await f.game.afterRound(f.ctx(1));
  assert.equal(entry(f), undefined); assert.equal(f.ctx(1).session.wallet, before + deposit);
  await new BlackjackGame().afterRound(f.ctx(1)); assert.equal(f.ctx(1).session.wallet, before + deposit);
});

test('failed deposit persistence and rejected/refailed cash-outs retain resident retry ledgers across hot reload', async () => {
  const f = fixture(); let debits = 0, credits = 0, failPersist = true, rejectCredit = true;
  f.io.wallet = {
    debit(s, n) { debits++; s.wallet -= n; return { ok: true }; },
    credit(s, n) { if (rejectCredit) return { ok: false }; credits++; s.wallet += n; return { ok: true }; },
    async persist() { if (failPersist) throw new Error('persist failed'); },
  };
  f.apply(); await assert.rejects(f.boundary(), /persist failed/); assert.equal(debits, 1);
  failPersist = false; await new BlackjackGame().afterRound(f.ctx(1)); assert.equal(debits, 1);
  f.request(1, 4510, { bankerType: 1 });
  await assert.rejects(f.game.afterRound(f.ctx(1)), /cash-out rejected/);
  assert.equal(credits, 0); assert.equal(f.table.casinoBankers.refunds.length, 1);
  rejectCredit = false; failPersist = true;
  await assert.rejects(new BlackjackGame().afterRound(f.ctx(1)), /persist failed/); assert.equal(credits, 1);
  failPersist = false; await new BlackjackGame().afterRound(f.ctx(1)); assert.equal(credits, 1);
  assert.equal(f.ctx(1).session.wallet, 100000); assert.equal(f.table.casinoBankers.entries.length, 0);
});

test('queued wallet recheck, mid-hand disconnect, expiry and automatic count/loss retirement preserve bankroll', async () => {
  const insufficient = fixture(); insufficient.apply(); insufficient.ctx(1).session.wallet = 500; await insufficient.boundary();
  assert.equal(entry(insufficient), undefined); assert.equal(last(insufficient, 9999).msgCode, 990101);
  for (const reason of ['disconnect', 'expiry', 'count', 'loss']) {
    const f = fixture(); f.apply(); await f.boundary(); wager(f, [9, 6, 8, 7]);
    if (reason === 'disconnect') f.game.onLeave(f.ctx(1));
    else if (reason === 'expiry') f.table.createdAt = Date.now() - 8 * 60 * 60 * 1000 - 1;
    else if (reason === 'count') entry(f).totalBankerCount = 9;
    else entry(f).amount = 1000;
    await f.game.afterRound(f.ctx(1)); assert.ok(entry(f).onBanker);
    finish(f); const amount = entry(f).amount, before = f.ctx(1).session.wallet; cleanup(f);
    await f.boundary(); assert.equal(entry(f), undefined, reason);
    assert.equal(f.ctx(1).session.wallet, before + amount, reason);
    if (reason === 'expiry') assert.equal(prepareClosure(f.table).payouts.has(1), false, 'expiry cannot refund banker twice');
  }
});

test('uncollateralized exposure remains with the system dealer and real bankers never overspend frozen limits', async () => {
  const f = fixture(); f.apply(1, 1, 10000, 10000); await f.boundary();
  const c = f.ctx(2); f.game.onSitDown({ ...c, body: { position: 1 } });
  engine.begin(f.io, f.table, 1000, [9, 6, 0, 9, ...makeShoe()]);
  assert.ok(engine.act(f.io, f.table, 2, SEND.BET, { betAmount: 10000 }, 1001));
  finish(f);
  const frozen = f.table.hand.bankers[0];
  assert.equal(frozen.cap, 10000); assert.equal(frozen.denominator, 60000);
  assert.equal(f.table.hand.results[0].score, 15000, 'player receives full original blackjack payout');
  assert.equal(frozen.score, -2500); assert.equal(entry(f).amount, 7500);
  assert.equal(f.table.houseNetScore, -12500, 'system covers the uncollateralized share');
  assert.equal(f.ctx(1).session.wallet + entry(f).amount + f.ctx(2).session.wallet + f.table.members[0].point + f.table.houseNetScore, 200000);
});

test('extending the last requested banker hand takes effect before automatic count retirement', async () => {
  const f = fixture(); f.apply(); await f.boundary(); entry(f).totalBankerCount = 9;
  wager(f, [9, 6, 8, 7]);
  f.request(1, 4511, { bankerType: 1, bankerCount: 20 }); assert.equal(last(f, 4560).code, 6);
  finish(f); cleanup(f); await f.boundary();
  assert.equal(entry(f).totalBankerCount, 10); assert.equal(entry(f).bankerCount, 20); assert.equal(entry(f).onBanker, true);
});

test('thirty real banker hands survive game replacement and end with exact refunds and bounded history', async () => {
  const f = fixture(); f.apply(); f.apply(1, 2); f.apply(3);
  for (const [uid, type] of [[1, 1], [1, 2], [3, 1]]) f.request(uid, 4511, { bankerType: type, bankerCount: 30 });
  const c = f.ctx(2); f.game.onSitDown({ ...c, body: { position: 1 } });
  for (let i = 0; i < 30; i++) {
    await f.boundary();
    engine.begin(f.io, f.table);
    assert.ok(engine.act(f.io, f.table, 2, SEND.BET, { betAmount: 100 * (1 + i % 10) }));
    finish(f);
    const bankroll = f.table.casinoBankers.entries.reduce((n, e) => n + e.amount, 0);
    const escrow = f.table.members.reduce((n, m) => n + m.point, 0);
    assert.equal([...f.sessions.values()].reduce((n, s) => n + s.wallet, 0) + bankroll + escrow + f.table.houseNetScore, 300000);
    assert.ok(f.table.hand.bankers.every(b => Math.abs(b.score) <= b.cap && b.entry.amount >= 0));
    cleanup(f);
    if (i === 15) await new BlackjackGame().afterRound(f.ctx(1));
  }
  await f.boundary();
  assert.equal(f.table.casinoBankers.entries.length, 0);
  assert.deepEqual(f.table.casinoBankers.history.map(a => a.length), [10, 10]);
  assert.equal(f.table.roomFeatures.players.get(1).totalHands, 30);
  assert.equal(f.messages.filter(m => m.uid === 1 && m.id === 4562).length, 30);
});
