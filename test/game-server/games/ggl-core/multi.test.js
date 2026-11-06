import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../../game-server/src/codec.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { LocalWallet } from '../../../../cache/wallet/LocalWallet.js';
import { createScratchTickets } from '../../../../cache/game-server/scratch-tickets.js';
import { scratchRequest } from '../../../../game-server/src/games/ggl-core/engine.js';
import { ERROR } from '../../../../game-server/src/games/ggl-core/rules.js';

const mask = n => [...Array(n).fill(1), ...Array(20 - n).fill(8)];
async function fixture(wins = 2) {
  const registry = createRegistry(), configs = seedRooms(), messages = [], resident = {};
  const wallet = new LocalWallet({ localBalance: 100000 });
  const runtime = { env: 'dev', registry, configs, wallet, findConfig, hotVersion: 'scratch-multi-1',
    log: { info() {}, error() {} }, scratchTickets: createScratchTickets({ resident, draw: () => mask(wins) }) };
  let handler = await createHandler(runtime);
  const ws = { readyState: 1, send(frame) { messages.push(decodeFrame(frame)); } };
  const session = registry.bind(ws, { userId: 8811, agentId: 7, authenticated: true, inRoom: true,
    roomId: 700000, gameId: 'holdem', wallet: 100000 });
  const host = handler.games.byRoomType.get(19).createTable(700000, 19, configs.find(row => row.room_type === 19));
  registry.setTable(700000, host, 7, 'holdem');
  await wallet.load(session);
  const send = (id, body) => handler.onMessage(ws, encodeFrame(id, body));
  const last = id => messages.findLast(m => m.msgid === id)?.payload;
  const register = async (customData = 1) => {
    await send(6123, { mulRoomTypeList: [{ roomType: 61 }, { roomType: 63 }], customData });
    return last(6227).roomInfos;
  };
  const buy = (room, faceValue = 100, extra = {}) => send(6127, { roomId: room.roomId,
    faceValue, kind: room.roomType === 61 ? 'ggl1' : 'ggl2', revealMode: 'RANDOM_BUY_REVEAL', serialFull: '', ...extra });
  return { runtime, registry, messages, resident, wallet, ws, session, host, send, last, register, buy,
    get handler() { return handler; },
    async reload() { runtime.hotVersion = 'scratch-multi-2'; handler = await createHandler(runtime); } };
}

test('native category registration exposes both scratch games without selecting or seating them', async () => {
  const f = await fixture(), rooms = await f.register();
  assert.deepEqual(rooms.map(r => r.roomType).sort(), [61, 63]);
  assert.equal(f.last(6227).customData, 1);
  for (const room of rooms) {
    assert.equal(room.roomIndex, 26);
    assert.equal(room.maintenance, false);
    assert.deepEqual(room.denominations, [100, 200, 500, 1000, 2000, 3000, 5000, 10000]);
    assert.equal(room.winMultipliers.length, 20);
    assert.equal(room.gglParams.gameRoomConfigId, room.roomType === 61 ? 6101 : 6301);
    assert.equal(Object.hasOwn(room, 'pendingTickets'), false);
  }
  assert.equal(f.session.roomId, 700000); assert.equal(f.session.gameId, 'holdem');
  assert.equal(f.session.hundredInRoom, undefined); assert.equal(f.host.members.length, 0);
  assert.equal(f.messages.some(m => [2201, 6205, 3711, 6207].includes(m.msgid)), false);
  await f.send(6126, { roomType: 63 });
  assert.ok(f.last(6230).every(r => r.roomType === 63));
});

test('same denomination concurrent purchases use the existing serialized wallet and ticket history', async () => {
  const f = await fixture(), rooms = await f.register();
  await Promise.all(rooms.map(room => f.buy(room, 100)));
  const receipts = f.messages.filter(m => m.msgid === 6231).map(m => m.payload);
  assert.equal(receipts.length, 2);
  assert.equal(new Set(receipts.map(r => r.serialFull)).size, 2);
  assert.deepEqual(receipts.map(r => r.roomType).sort(), [61, 63]);
  for (const r of receipts) {
    assert.equal(r.code, 0); assert.equal(r.faceValue, 100);
    assert.equal(r.huCount, 2); assert.equal(r.multiplier, 1); assert.equal(r.winAmount, 100);
    assert.equal(r.huMask.length, 20); assert.equal(r.walletAmount, 100000);
    const table = f.registry.getTable(r.roomId, 7, r.roomType === 61 ? 'ggl-mjhl' : 'ggl-queen');
    const history = await f.runtime.scratchTickets.history({ runtime: f.runtime, table, session: f.session });
    assert.equal(history.length, 1); assert.equal(history[0].serialNo, r.serialFull);
  }
  assert.ok(f.messages.filter(m => m.msgid === 9212).every(m => Number.isFinite(m.payload)));
  assert.equal(f.messages.some(m => [3713, 6226, 6229].includes(m.msgid)), false);
  assert.equal(f.session.wallet, 100000);
});

test('bad denominations, kind, mode, insufficient funds and unsubscribed rooms fail before charging', async () => {
  const f = await fixture(0), [room] = await f.register();
  for (const extra of [{ kind: 'ggl2' }, { revealMode: 'SPECIFIED' }, { serialFull: 'fake' }, { roomType: 50 }]) {
    await f.buy(room, 100, extra); assert.notEqual(f.last(6231).code, 0);
    assert.equal(f.last(6231).faceValue, 100);
  }
  for (const value of [0, -1, 100.5, '100', 101, 10001, null]) {
    await f.buy(room, value); assert.notEqual(f.last(6231).code, 0);
  }
  assert.equal(f.session.wallet, 100000);
  f.session.wallet = 50; await f.wallet.persist(f.session);
  await f.buy(room); assert.equal(f.last(6231).code, ERROR.BALANCE); assert.equal(f.session.wallet, 50);
  await f.send(6124, {});
  await f.buy(room); assert.equal(f.last(6231).code, 95041);
  assert.equal(f.session.inRoom, true); assert.equal(f.session.roomId, 700000);
});

test('agent isolation, maintenance and the hundred-bet route cannot bypass scratch authorization', async () => {
  const f = await fixture(0), [room] = await f.register();
  await f.send(6125, { roomId: room.roomId, roomType: 61, params: [{ areaId: 1, total: 100 }] });
  assert.equal(f.last(6226).code, 95041);
  const table = f.registry.getTable(room.roomId, 7, 'ggl-mjhl');
  f.registry.removeTable(room.roomId, 7, table.gameId); f.registry.setTable(room.roomId, table, 8, table.gameId);
  await f.buy(room); assert.equal(f.last(6231).code, 95041);
  f.registry.removeTable(room.roomId, 8, table.gameId); f.registry.setTable(room.roomId, table, 7, table.gameId);
  const row = f.runtime.configs.find(row => row.game_room_config_id === 6101);
  row.state = 0;
  await f.buy(room); assert.equal(f.last(6231).code, 95041);
  assert.equal(f.session.wallet, 100000);
});

test('multiple subscription contexts survive hot reload without losing main hundred selection', async () => {
  const f = await fixture(0);
  await f.send(6105, { roomType: 50, playMode: 1 });
  const mainId = f.session.hundredRoomId;
  const [room] = await f.register(1);
  await f.register(2); await f.reload();
  await f.send(6124, { customData: 1, mulRoomTypeList: [{ roomType: 61 }, { roomType: 63 }] });
  await f.buy(room); assert.equal(f.last(6231).code, 0);
  assert.equal(f.session.wallet, 99900);
  assert.equal(f.session.hundredRoomId, mainId);
  await f.send(6124, {}); await f.buy(room); assert.equal(f.last(6231).code, 95041);
  assert.deepEqual([...f.session.hundredRoomIds], [mainId]);
  assert.equal(f.registry.getTable(mainId, 7, 'hundred-holdem').visitors.has(8811), true);
});

test('accepted ticket completes after socket close and pending failed prize recovers without a second debit', async () => {
  const f = await fixture(2), [room] = await f.register();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const credit = f.wallet.credit.bind(f.wallet);
  f.wallet.credit = async (...args) => { await held; return credit(...args); };
  const request = f.buy(room);
  while (f.session.wallet === 100000) await new Promise(resolve => setImmediate(resolve));
  f.ws.readyState = 3;
  const closing = f.handler.onClose(f.ws);
  release(); await Promise.all([request, closing]);
  assert.equal(f.session.wallet, 100000);
  const table = f.registry.getTable(room.roomId, 7, 'ggl-mjhl');
  const ctx = { runtime: f.runtime, table, session: f.session };
  assert.equal((await f.runtime.scratchTickets.history(ctx)).length, 1);

  const g = await fixture(2), [other] = await g.register();
  g.wallet.credit = async () => ({ ok: false });
  await g.buy(other); assert.equal(g.last(6231).code, ERROR.STORAGE); assert.equal(g.session.wallet, 99900);
  await g.buy(other); assert.equal(g.last(6231).code, ERROR.STORAGE); assert.equal(g.session.wallet, 99900);
  const pendingTable = g.registry.getTable(other.roomId, 7, 'ggl-mjhl');
  const pendingCtx = { runtime: g.runtime, table: pendingTable, session: g.session };
  const state = await scratchRequest(pendingCtx, 'state');
  assert.equal(state.pendingTickets.length, 1);
  g.wallet.credit = LocalWallet.prototype.credit.bind(g.wallet);
  const paid = await scratchRequest(pendingCtx, 'reveal', { revealMode: 'SPECIFIED', serialFull: state.pendingTickets[0].serialFull });
  assert.equal(paid.code, 0); assert.equal(g.session.wallet, 100000);
});

test('production multi route fails explicitly without an authoritative ticket service', async () => {
  const f = await fixture(), [room] = await f.register();
  f.runtime.env = 'prod'; delete f.runtime.scratchTickets;
  await f.buy(room);
  assert.equal(f.last(6231).code, ERROR.STORAGE); assert.equal(f.last(6231).faceValue, 100);
  assert.equal(f.session.wallet, 100000);
});
