import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGames } from '../../../../game-server/src/games/catalog.js';
import { prizeFromMask, WIN_MULTIPLIERS, ERROR } from '../../../../game-server/src/games/ggl-core/rules.js';
import { createScratchTickets } from '../../../../cache/game-server/scratch-tickets.js';
import { LocalWallet } from '../../../../cache/wallet/LocalWallet.js';
import { list } from '../../../../game-server/src/games/ggl-core/history.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry } from '../../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../../game-server/src/codec.js';
const games = await loadGames('scratch-tests');
const mask = n => [...Array(n).fill(1), ...Array(20 - n).fill(8)];
function fixture(type = 61, wins = 9) {
  const game = games.byRoomType.get(type), table = game.createTable(type * 10000 + 26, type, {});
  const wallet = new LocalWallet({ localBalance: 100000 }), resident = {};
  const runtime = { env: 'dev', wallet, log: { error() {} }, scratchTickets: createScratchTickets({ resident, draw: () => mask(wins) }) };
  const sent = [], ctx = { runtime, table, session: { userId: 9, agentId: 1, wallet: 100000 }, send(id, payload) { sent.push({ id, payload }); } };
  async function request(id, body = {}) { await game.onMessage(ctx, id, body); return sent.at(-1).payload; }
  return { game, table, runtime, wallet, resident, sent, ctx, request, kind: type === 63 ? 'ggl2' : 'ggl1' };
}

test('winning symbol counts 0..20 map exactly to original multiplier table', () => {
  for (let n = 0; n <= 20; n++) {
    const p = prizeFromMask(mask(n)); assert.equal(p.huCount, n); assert.equal(p.multiplier, n ? WIN_MULTIPLIERS[n - 1] : 0);
  }
  assert.equal(prizeFromMask(Array(20).fill(8)).multiplier, 0);
  assert.throws(() => prizeFromMask([1]));
  assert.throws(() => prizeFromMask(Array(20).fill(NaN)));
});
for (const type of [61, 63]) {
  test('native scratch lifecycle, prizes and private history ' + type, async () => {
    const f = fixture(type); const state = await f.request(3702);
    assert.equal(state.walletAmount, 100000); assert.equal(state.winMultipliers.length, 20); assert.deepEqual(state.pendingTickets, []);
    assert.equal(f.game.buildConf(f.table).roomType, type === 61 ? 'mjhl' : 'sjnv');
    const result = await f.request(3701, { faceValue: 100, kind: f.kind, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' });
    assert.equal(f.sent.at(-1).id, 3713); assert.equal(result.code, 0); assert.equal(result.multiplier, 20);
    assert.equal(result.huCount, 9); assert.equal(result.winAmount, 2000); assert.equal(result.walletAmount, 101900); assert.equal(result.prizeTier, 'BIG');
    assert.equal(result.accumulatedWinByKind[f.kind.toUpperCase()], 2000);
    const history = await f.request(6121, { roomType: type });
    assert.equal(history.winInfo.length, 1); assert.equal(history.winInfo[0].amount, 1900); assert.equal(history.winInfo[0].serialNo, result.serialFull);
    const replay = await f.request(3701, { kind: f.kind, revealMode: 'SPECIFIED', serialFull: result.serialFull, faceValue: 10000 });
    assert.equal(replay.code, 0); assert.equal(replay.walletAmount, 101900); assert.equal((await f.request(6121)).winInfo.length, 1);
    f.ctx.session = { userId: 10, agentId: 1, wallet: 100000 };
    assert.deepEqual((await f.request(6121)).winInfo, []);
    assert.equal((await f.request(3701, { revealMode: 'SPECIFIED', serialFull: result.serialFull })).code, ERROR.STORAGE);
  });
  test('search and buy a book, pending survives service replacement and reveal is not charged twice ' + type, async () => {
    const f = fixture(type, 0);
    const search = await f.request(3703, { kind: f.kind, searchType: 'BOOK_TAIL', bookTail: '789' });
    assert.equal(f.sent.at(-1).id, 3714); assert.equal(search.matchedSerials.length, 10);
    const book = search.matchedSerials[0]; assert.ok(book.split('-')[2].endsWith('789'));
    const buy = await f.request(3704, { kind: f.kind, faceValue: 200, purchaseMode: 'FULL_BOOK', bookId7List: [book] });
    assert.equal(f.sent.at(-1).id, 3712); assert.equal(buy.code, 0); assert.equal(buy.newTickets.length, 20); assert.equal(buy.walletAmount, 96000);
    assert.ok(buy.newTickets.every(t => !('huMask' in t) && !('winAmount' in t)));
    f.runtime.scratchTickets = createScratchTickets({ resident: f.resident, draw: () => mask(20) });
    f.ctx.session = { userId: 9, agentId: 1, wallet: 0 };
    assert.equal((await f.request(3702)).pendingTickets.length, 20);
    const result = await f.request(3701, { kind: f.kind, faceValue: 10000, serialFull: buy.newTickets[0].serialFull, revealMode: 'SPECIFIED' });
    assert.equal(result.code, 0); assert.equal(result.faceValue, 200); assert.equal(result.winAmount, 0); assert.equal(result.walletAmount, 96000);
    assert.equal((await f.request(3702)).pendingTickets.length, 19);
  });
}

test('invalid amounts, kinds, modes, selections and suffixes never change balance', async () => {
  const f = fixture();
  for (const faceValue of [undefined, NaN, Infinity, -100, 0, 1, 100.5, '100', null]) {
    assert.notEqual((await f.request(3701, { faceValue, kind: f.kind, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, 0);
  }
  for (const body of [{ faceValue: 100, revealMode: 'BAD', serialFull: '' }, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '', kind: 'ggl2' }]) assert.notEqual((await f.request(3701, body)).code, 0);
  for (const body of [null, [], 42, 'bad']) assert.notEqual((await f.request(3701, body)).code, 0);
  assert.notEqual((await f.request(3703, { searchType: 'BOOK_TAIL', bookTail: '*' })).code, 0);
  assert.notEqual((await f.request(3704, { purchaseMode: 'FULL_BOOK', faceValue: 100, bookId7List: ['unoffered'] })).code, 0);
  assert.equal(f.ctx.session.wallet, 100000); assert.equal((await f.request(6121)).winInfo.length, 0);
});
test('single search and partial purchase returns failedItems; duplicate purchases cannot charge', async () => {
  const f = fixture(); const found = await f.request(3703, { searchType: 'SINGLE_TICKET', bookTail: '123', ticketTail: '02' });
  assert.equal(found.matchedSerials.length, 10);
  const body = { faceValue: 100, purchaseMode: 'RANDOM_SINGLE', serialFulls: [found.matchedSerials[0], 'unoffered'] };
  const r = await f.request(3704, body); assert.equal(r.newTickets.length, 1); assert.equal(r.failedItems.length, 1); assert.equal(r.walletAmount, 99900);
  assert.notEqual((await f.request(3704, body)).code, 0); assert.equal(f.ctx.session.wallet, 99900);
});
test('credit failure keeps pending ticket and retry credits once under concurrent requests', async () => {
  const f = fixture(); let calls = 0;
  const original = f.wallet.credit.bind(f.wallet); f.wallet.credit = async (...args) => { if (++calls === 1) return { ok: false }; await new Promise(r => setTimeout(r, 5)); return original(...args); };
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.STORAGE);
  assert.equal(f.ctx.session.wallet, 99900);
  const state = await f.request(3702); assert.equal(state.pendingTickets.length, 1);
  const body = { revealMode: 'SPECIFIED', serialFull: state.pendingTickets[0].serialFull };
  await Promise.all([f.request(3701, body), f.request(3701, body)]);
  assert.equal(calls, 2); assert.equal(f.ctx.session.wallet, 101900); assert.equal((await f.request(6121)).winInfo.length, 1);
});
test('persist failure after credit does not repay prize and blocks a second random purchase', async () => {
  const f = fixture(); let persists = 0;
  f.wallet.persist = async () => { if (++persists === 2) throw new Error('persist unavailable'); };
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.STORAGE);
  const state = await f.request(3702); assert.equal(state.pendingTickets.length, 1); assert.equal(state.walletAmount, 101900);
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.STORAGE);
  assert.equal((await f.request(3701, { revealMode: 'SPECIFIED', serialFull: state.pendingTickets[0].serialFull })).walletAmount, 101900);
});
test('insufficient wallet never produces a free ticket or history', async () => {
  const f = fixture(); f.ctx.session.wallet = 50; await f.wallet.persist(f.ctx.session);
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.BALANCE);
  assert.equal((await f.request(3702)).pendingTickets.length, 0); assert.equal((await f.request(6121)).winInfo.length, 0);
});
test('production missing ticket authority fails closed without simulated outcome', async () => {
  const f = fixture(); delete f.runtime.scratchTickets; f.runtime.env = 'prod';
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.STORAGE);
  assert.equal(f.ctx.session.wallet, 100000);
  f.runtime.scratchTickets = { reveal() { return null; } };
  assert.equal((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).code, ERROR.STORAGE);
});
test('production history uses scoped Redis then data-center, merges requests and checks ownership', async () => {
  const f = fixture(), cache = new Map(); let queries = 0;
  const good = { userId: 9, agentId: 0, gameId: 61, init: JSON.stringify({ roomId: f.table.roomId, gameRoomId: f.table.gameRoomId, serialNo: 'ticket', faceValue: 100, amount: 1900, huCount: 9, multiplier: 20, huMask: mask(9) }) };
  f.runtime.rpc = { bus: { getCache: async k => cache.get(k), setCache: async (k, v, ttl) => { assert.equal(ttl, 30); assert.ok(k.startsWith('scratch:0:61:')); cache.set(k, v); } },
    gateway: { getRecords: async () => { queries++; await new Promise(r => setTimeout(r, 5)); return { data: [good, { ...good, userId: 11 }, { ...good, agentId: 2 }, { ...good, gameId: 63 }] }; } } };
  const result = await Promise.all([list(f.ctx), list(f.ctx)]); assert.equal(queries, 1); assert.equal(result[0].winInfo.length, 1);
  assert.equal((await list(f.ctx)).winInfo.length, 1); assert.equal(queries, 1);
});
test('versioned scratch game and base reload while preserving resident inventory', async () => {
  for (const version of ['scratch-hot-1', 'scratch-hot-2']) {
    const { SlotsGame } = await import('../../../../game-server/src/core/SlotsGame.js?v=' + version);
    for (const type of [61, 63]) assert.ok((await loadGames(version)).byRoomType.get(type) instanceof SlotsGame);
  }
});

test('concurrent sessions and both games share one account wallet queue', async () => {
  const f = fixture(61, 0), other = fixture(63, 0);
  other.ctx.runtime = f.runtime;
  other.ctx.session = { userId: 9, agentId: 1, wallet: 100000 };
  const body = kind => ({ faceValue: 100, kind, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' });
  await Promise.all([f.game.onMessage(f.ctx, 3701, body('ggl1')), other.game.onMessage(other.ctx, 3701, body('ggl2'))]);
  await f.runtime.wallet.load(f.ctx.session);
  assert.equal(f.ctx.session.wallet, 99800);
  assert.equal((await f.request(6121)).winInfo.length, 1);
  assert.equal((await other.ctx.runtime.scratchTickets.history(other.ctx)).length, 1);
});
test('same offered serial cannot be sold to two players during asynchronous debit', async () => {
  const f = fixture(61, 0), other = { ...f.ctx, session: { userId: 10, agentId: 1, wallet: 100000 }, send() {} };
  const search = { searchType: 'SINGLE_TICKET', bookTail: '1234567', ticketTail: '01' };
  const a = await f.runtime.scratchTickets.search(f.ctx, search), b = await f.runtime.scratchTickets.search(other, search);
  assert.equal(a.matchedSerials[0], b.matchedSerials[0]);
  const original = f.wallet.debit.bind(f.wallet); f.wallet.debit = async (...args) => { await new Promise(r => setTimeout(r, 5)); return original(...args); };
  const body = { purchaseMode: 'RANDOM_SINGLE', faceValue: 100, serialFulls: [a.matchedSerials[0]] };
  const results = await Promise.allSettled([f.runtime.scratchTickets.purchase(f.ctx, body), f.runtime.scratchTickets.purchase(other, body)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await f.runtime.scratchTickets.state(other)).pendingTickets.length, 0);
  assert.equal(other.session.wallet, 100000);
});
test('expired offers fail, paid pending tickets remain recoverable and agents are isolated', async () => {
  const f = fixture(61, 0), resident = {}; let clock = Date.now();
  f.runtime.scratchTickets = createScratchTickets({ resident, now: () => clock, draw: () => mask(0) });
  const found = await f.request(3703, { searchType: 'BOOK_TAIL', bookTail: '123' });
  clock += 60001;
  assert.notEqual((await f.request(3704, { purchaseMode: 'FULL_BOOK', faceValue: 100, bookId7List: [found.matchedSerials[0]] })).code, 0);
  const newer = await f.request(3703, { searchType: 'BOOK_TAIL', bookTail: '123' });
  const paid = await f.request(3704, { purchaseMode: 'FULL_BOOK', faceValue: 100, bookId7List: [newer.matchedSerials[0]] });
  clock += 25 * 3600000;
  assert.equal((await f.request(3702)).pendingTickets.length, 20);
  f.ctx.session.agentId = 2;
  assert.equal((await f.request(3702)).pendingTickets.length, 0);
  assert.notEqual((await f.request(3701, { revealMode: 'SPECIFIED', serialFull: paid.newTickets[0].serialFull })).code, 0);
  f.ctx.session.agentId = 1;
  assert.equal((await f.request(3702)).pendingTickets.length, 20);
});
test('history is capped to last 100 in chronological order and is private to the current room', async () => {
  const f = fixture(61, 0), serials = [];
  for (let i = 0; i < 103; i++) serials.push((await f.request(3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' })).serialFull);
  const records = (await f.request(6121)).winInfo;
  assert.equal(records.length, 100); assert.equal(records[0].serialNo, serials[3]); assert.equal(records.at(-1).serialNo, serials.at(-1));
  f.ctx.table = { ...f.table, roomId: f.table.roomId + 1, gameRoomId: f.table.gameRoomId + 1 };
  assert.deepEqual((await f.request(6121)).winInfo, []);
});
test('native handler routes 6121 correctly and every scratch wallet push is numeric', async () => {
  for (const type of [61, 63]) {
    const f = fixture(type, 0), registry = createRegistry(), received = [];
    const ws = { readyState: 1, send(frame) { received.push(decodeFrame(frame)); } };
    const row = { room_id: f.table.roomId, game_room_config_id: type === 61 ? 6101 : 6301, game_type: 1004, room_type: type, room_index: 26 };
    const runtime = { ...f.runtime, registry, configs: [row], findConfig: () => row, hotVersion: 'scratch-handler-' + type,
      gateway: { async getUserInfo() { return { userId: 9, agentId: 1, nickName: 'scratch-player' }; } } };
    const handler = await createHandler(runtime);
    await handler.onMessage(ws, encodeFrame(1105, { userId: 9, roomId: f.table.roomId }));
    await handler.onMessage(ws, encodeFrame(2102, { roomId: f.table.roomId, roomType: type }));
    await handler.onMessage(ws, encodeFrame(3702, {}));
    await handler.onMessage(ws, encodeFrame(3701, { kind: f.kind, faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' }));
    await handler.onMessage(ws, encodeFrame(6121, { roomType: type, roomId: f.table.roomId }));
    await handler.onMessage(ws, encodeFrame(2110, {}));
    assert.equal(received.find(f => f.msgid === 3713).payload.code, 0);
    assert.equal(received.find(f => f.msgid === 6221).payload.winInfo.length, 1);
    assert.ok(received.some(f => f.msgid === 2205));
    assert.ok(received.filter(f => f.msgid === 9212).every(f => Number.isFinite(f.payload)));
  }
});

test('leaving during prize credit waits for accepted purchase and keeps completed record', async () => {
  const f = fixture(); let credited = false;
  const original = f.wallet.credit.bind(f.wallet);
  f.wallet.credit = async (...args) => { await new Promise(r => setTimeout(r, 10)); const value = original(...args); credited = true; return value; };
  const purchase = f.game.onMessage(f.ctx, 3701, { faceValue: 100, revealMode: 'RANDOM_BUY_REVEAL', serialFull: '' });
  const leaving = f.game.beforeLeave(f.ctx).then(() => { assert.equal(credited, true); assert.equal(f.ctx.session.wallet, 101900); });
  await Promise.all([purchase, leaving]);
  assert.equal(f.ctx.session.inRoom, false);
  assert.equal((await f.runtime.scratchTickets.history(f.ctx)).length, 1);
});
