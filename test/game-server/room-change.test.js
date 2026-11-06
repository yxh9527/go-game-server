import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { LocalWallet } from '../../cache/wallet/LocalWallet.js';
import * as niuniu from '../../game-server/src/games/niuniu/engine.js';

async function fixture() {
  const registry = createRegistry(), configs = seedRooms(), wallet = new LocalWallet({ localBalance: 100000 });
  const runtime = { env: 'dev', registry, configs, wallet, findConfig, hotVersion: 'room-change-1',
    gateway: { async getLoginData(uid) { return { userId: uid, agentId: 7, userName: 'player' }; } },
    log: { info() {}, error() {} } };
  let handler = await createHandler(runtime);
  const messages = [], ws = { readyState: 1, send(raw) { messages.push(decodeFrame(raw)); } };
  const request = (id, body) => handler.onMessage(ws, encodeFrame(id, body));
  await request(1105, { userId: 7711, roomId: 700000 });
  const session = registry.session(ws);
  const row = type => configs.find(r => r.room_type === type && (type !== 31 || r.play_mode === 0));
  async function join(type, index = 0) {
    const cfg = row(type), roomId = cfg.game_room_config_id * 10000 + Number(cfg.room_index || 0) + index;
    await request(2102, { roomId, roomType: type, changeRoom: true, isOb: true });
    return registry.getTable(session.roomId, session.agentId, session.gameId);
  }
  async function carry(table) {
    await request(5003, { position: 0 });
    await request(5001, { carryIn: table.carryMin / 100 });
    assert.equal(table.members.find(m => m.uid === session.userId).point, table.carryMin);
  }
  return { runtime, registry, messages, wallet, ws, request, session, row, join, carry,
    get handler() { return handler; }, async reload() { runtime.hotVersion = 'room-change-2'; handler = await createHandler(runtime); } };
}

test('cash games switch through the common join/leave flow and enter the target as observer', async () => {
  for (const type of [19, 25, 24, 27, 31, 32, 26, 28, 30]) {
    const f = await fixture(), old = await f.join(type);
    assert.equal(f.session.clubId, 7);
    const balance = f.session.wallet;
    await f.carry(old);
    let credits = 0; const credit = f.wallet.credit.bind(f.wallet);
    f.wallet.credit = (...args) => { credits++; return credit(...args); };
    const start = f.messages.length;
    const target = await f.join(type === 19 ? 25 : 19);
    assert.ok(!old.members.some(m => m.uid === f.session.userId));
    assert.ok(!old.observers.some(m => m.uid === f.session.userId));
    assert.ok(target.observers.some(m => m.uid === f.session.userId));
    assert.ok(!target.members.some(m => m.uid === f.session.userId));
    assert.equal(f.session.wallet, balance);
    assert.equal(credits, 1);
    const outgoing = f.messages.slice(start).filter(m => m.msgid === 2205);
    assert.ok(outgoing.every(m => m.payload.roomId === old.roomId));
    assert.equal(f.messages.findLast(m => m.msgid === 2201).payload.roomId, target.roomId);
    await f.request(2102, { roomId: target.roomId, roomType: target.roomType, isOb: true });
    assert.equal(credits, 1);
    assert.equal(target.observers.filter(m => m.uid === f.session.userId).length, 1);
  }
});

test('failed cash-out blocks destination, retries across hot reload, and never pays twice after persistence failure', async () => {
  const f = await fixture(), old = await f.join(19);
  await f.carry(old);
  const targetId = f.row(25).game_room_config_id * 10000;
  let reject = true, credits = 0, failPersist = true;
  const credit = f.wallet.credit.bind(f.wallet), persist = f.wallet.persist.bind(f.wallet);
  f.wallet.credit = (...args) => {
    if (reject) return { ok: false };
    credits++; return credit(...args);
  };
  f.wallet.persist = async session => {
    if (failPersist) throw new Error('store unavailable');
    return persist(session);
  };
  await assert.rejects(f.request(2102, { roomId: targetId, roomType: 25 }), /cash-out rejected/);
  assert.equal(f.session.roomId, old.roomId); assert.ok(f.session.roomLeave);
  assert.equal(f.messages.some(m => m.msgid === 2201 && m.payload.roomId === targetId), false);
  reject = false;
  await f.reload();
  await assert.rejects(f.request(2110, {}), /store unavailable/);
  assert.equal(credits, 1); assert.equal(f.session.wallet, 100000);
  failPersist = false;
  await f.request(2102, { roomId: targetId, roomType: 25 });
  assert.equal(credits, 1); assert.equal(f.session.roomLeave, undefined);
  assert.equal(f.session.roomId, targetId); assert.equal(f.session.wallet, 100000);
});

test('concurrent target joins serialize and do not leave duplicate observers or refund twice', async () => {
  const f = await fixture(), old = await f.join(19); await f.carry(old);
  const a = f.row(25).game_room_config_id * 10000, b = f.row(24).game_room_config_id * 10000;
  let credits = 0; const credit = f.wallet.credit.bind(f.wallet);
  f.wallet.credit = async (...args) => { credits++; await new Promise(resolve => setImmediate(resolve)); return credit(...args); };
  await Promise.all([f.request(2102, { roomId: a, roomType: 25 }), f.request(2102, { roomId: b, roomType: 24 })]);
  assert.equal(credits, 1); assert.equal(f.session.roomId, b); assert.equal(f.session.wallet, 100000);
  const tables = f.registry.listAgentGameRooms(7).filter(table => table.observers?.some(m => m.uid === f.session.userId));
  assert.equal(tables.length, 1); assert.equal(tables[0].roomId, b);
});

test('unsettled Niuniu chips remain on the original hand after switching, and settle only once', async () => {
  const f = await fixture(), old = await f.join(24); await f.carry(old);
  const actor = old.members.find(m => m.uid === f.session.userId), funded = actor.point;
  old.members.push({ uid: 990001, pos: 1, point: funded, name: 'bot', bot: true });
  const io = { env: 'dev', wallet: f.wallet, broadcast() {}, forEachPlayer() {} };
  niuniu.begin(io, old, 1000);
  const hand = old.hand;
  await f.join(19);
  assert.equal(old.hand, hand); assert.equal(actor.pendingDeparture, true);
  assert.equal(actor.point, funded); assert.equal(f.session.wallet, 100000 - funded);
  let now = 1000;
  for (let i = 0; old.hand && i < 60; i++) { now += 1000; niuniu.tick(io, old, now); }
  assert.equal(old.hand, null);
  const settled = actor.point;
  await f.handler.games.byRoomType.get(24).afterRound({ runtime: f.runtime, table: old, io });
  assert.equal(old.members.some(m => m.uid === f.session.userId), false);
  assert.equal(f.session.wallet, 100000 - funded + settled);
  const balance = f.session.wallet;
  await f.handler.games.byRoomType.get(24).afterRound({ runtime: f.runtime, table: old, io });
  assert.equal(f.session.wallet, balance);
});

test('closed connections retain and retry unpaid cash-out without recreating their old seat', async () => {
  const f = await fixture(), old = await f.join(19); await f.carry(old);
  let reject = true; const credit = f.wallet.credit.bind(f.wallet);
  f.wallet.credit = (...args) => reject ? { ok: false } : credit(...args);
  f.ws.readyState = 3;
  await assert.rejects(f.handler.onClose(f.ws), /cash-out rejected/);
  assert.ok(f.registry.session(f.ws)?.roomLeave);
  reject = false; await f.reload(); await f.handler.tick();
  assert.equal(f.registry.session(f.ws), null); assert.equal(f.session.wallet, 100000);
  assert.equal(old.members.some(m => m.uid === f.session.userId), false);
});

test('field changes send the new room type before delivering snapshots to the prepared scene', async () => {
  const f = await fixture(); await f.join(19);
  const targetId = f.row(25).game_room_config_id * 10000;
  const start = f.messages.length;
  await f.request(2102, { roomId: targetId, roomType: 25, changeRoom: true });
  assert.equal(f.messages.slice(start).filter(m => m.msgid === 2201).length, 1);
  assert.equal(f.messages.slice(start).some(m => m.msgid === 2206), false);
  assert.equal(f.session.roomHydrating, true);
  await f.request(2111, {});
  assert.equal(f.session.roomHydrating, false);
  assert.equal(f.messages.findLast(m => m.msgid === 2206).payload.roomId, targetId);
});

test('direct Hundred field changes release snapshots at 6105 and keep the exact peek room', async () => {
  const f = await fixture(); await f.join(25);
  const config = f.runtime.configs.find(row => row.room_type === 59 && row.play_mode === 1);
  const id = config.game_room_config_id * 10000 + config.room_index;
  const start = f.messages.length;
  await f.request(2102, { roomId: id, roomType: 59, changeRoom: true });
  assert.equal(f.session.roomHydrating, true);
  assert.equal(f.messages.slice(start).some(m => m.msgid === 6205), false);
  await f.request(6105, { roomType: 59, playMode: 1, roomId: id, roomIndex: config.room_index });
  assert.equal(f.session.roomHydrating, false);
  const snapshot = f.messages.findLast(m => m.msgid === 6205).payload;
  assert.equal(snapshot.roomId, id); assert.equal(snapshot.playMode, 1);
  assert.equal(f.session.roomId, id); assert.equal(f.session.hundredRoomId, id);
  assert.equal(f.session.wallet, 100000);
});
