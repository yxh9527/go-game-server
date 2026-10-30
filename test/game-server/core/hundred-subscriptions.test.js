import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../game-server/src/codec.js';
import { seedRooms } from '../../../cache/rpc/seed.js';
import { applyCycle } from '../../../game-server/src/games/baccarat/engine.js';
import { hundredContexts } from '../../../game-server/src/core/hundred-subscriptions.js';

async function fixture(type = 60, agentId = 7) {
  const registry = createRegistry(), messages = [], configs = seedRooms();
  const session = { userId: 971, agentId, roomId: 700000, gameId: 'holdem', inRoom: true, authenticated: true, wallet: 1000000 };
  const ws = { readyState: 1, send(frame) { messages.push(decodeFrame(frame)); } };
  registry.bind(ws, session);
  const runtime = { registry, configs, findConfig, hotVersion: 'cross-shortcuts', log: { info() {}, error() {} },
    wallet: { debit(s, n) { assert.ok(n > 0 && n <= s.wallet); s.wallet -= n; return { ok: true }; },
      credit(s, n) { s.wallet += n; return { ok: true }; }, async persist() {} } };
  let handler = await createHandler(runtime);
  const send = (id, data) => handler.onMessage(ws, encodeFrame(id, data));
  await send(6105, { roomType: type, playMode: type === 60 ? 0 : 1 });
  const main = registry.getTable(session.hundredRoomId, agentId, session.hundredGameId);
  return { runtime, registry, session, ws, main, messages, send, get handler() { return handler; },
    async reload() { handler = await createHandler(runtime); } };
}

test('Blackjack discovers and subscribes Baccarat shortcuts without replacing its host or selected table', async () => {
  const f = await fixture();
  await f.send(6126, { roomType: 58, type: [] });
  const list = f.messages.find(m => m.msgid === 6230).payload;
  assert.equal(list.length, 50); assert.ok(list.every(r => r.roomType === 58));
  const selected = list.filter(r => r.playMode === 0).slice(0, 3);
  await f.send(6123, { roomType: 58, roomIds: selected.map(r => r.roomId), customData: 2 });
  const rooms = f.messages.findLast(m => m.msgid === 6227).payload;
  assert.equal(rooms.customData, 2); assert.equal(rooms.roomInfos.length, 3);
  for (const room of rooms.roomInfos) {
    assert.equal(room.roomType, 58); assert.ok(room.countDown > 0);
    assert.equal(room.hundredParams.betAreaOdds[1].oddsList[0], 100);
    assert.equal(room.hundredParams.betAreaOdds[2].oddsList[0], 95);
    assert.equal(room.ways[9].type, 16384);
    assert.ok(Array.isArray(room.ways[1].ways));
  }
  assert.equal(f.session.roomId, 700000); assert.equal(f.session.gameId, 'holdem');
  assert.equal(f.session.hundredGameId, 'hundred-blackjack');
  assert.equal(f.session.hundredRoomId, f.main.roomId); assert.equal(f.session.hundredRoomIds.size, 4);
  const roomId = list[0].roomId, table = f.registry.getTable(roomId, 7, 'baccarat');
  const before = f.session.wallet;
  await f.send(6125, { roomType: 58, roomId, params: [{ areaId: 1, total: 100 }] });
  const receipt = f.messages.findLast(m => m.msgid === 6226).payload;
  assert.equal(receipt.code, 0); assert.equal(receipt.customData, 2); assert.equal(receipt.points, before - 100);
  assert.equal(f.messages.findLast(m=>m.msgid===9212).payload,before-100);
  assert.equal(table.playerBets.get(971)[0].total, 100);
  assert.equal(f.messages.some(m => m.msgid === 6202 && m.payload.roomType === 58), false);
  await f.reload();
  await f.send(6123, { roomType: 58, roomIds: selected.map(r => r.roomId), customData: 2 });
  assert.equal(f.session.wallet, before - 100); assert.equal(table.people, 1);
  assert.equal(f.messages.findLast(m => m.msgid === 6227).payload.roomInfos[0].ownBets[1].total, 100);
  table.lastResult = { player:[3,4], banker:[0,1], areas:[1], p:9, b:3 };
  table.state = 4; table.hundredPhaseIndex = 2; table.phaseEndsAt = Date.now() - 1;
  const afterBet = f.messages.length; await f.handler.tick();
  const settlement = f.messages.slice(afterBet).filter(m=>m.msgid===6229&&m.payload.roomId===roomId);
  assert.equal(settlement.length,1); assert.equal(settlement[0].payload.customData,2);
  assert.equal(settlement[0].payload.realScore,100);
  assert.equal(f.messages.findLast(m=>m.msgid===9212).payload,before+100);
  assert.equal(f.messages.slice(afterBet).some(m=>[6204,6208,6212].includes(m.msgid)&&m.payload.roomType===58),false);
});

test('Mahjong subscribes all five native Holdem shortcuts and forwards timed updates only in the proper contexts', async () => {
  const f = await fixture(62);
  await f.send(6123, { mulRoomTypeList: [{ roomType: 50 }], customData: 2 });
  const rooms = f.messages.findLast(m => m.msgid === 6227).payload.roomInfos;
  assert.deepEqual(rooms.map(r => r.playMode).sort(), [1, 2, 3, 4, 5]);
  assert.ok(rooms.every(r => r.roomType === 50));
  const table = f.registry.getTable(rooms[0].roomId, 7, 'hundred-holdem');
  await f.send(6123, { mulRoomTypeList: [{ roomType: 50, roomIds: [table.roomId] }], customData: 1 });
  assert.deepEqual(hundredContexts(f.session, table).sort(), [1, 2]);
  const start = f.messages.length;
  f.handler.tick();
  const updates = f.messages.slice(start).filter(m => m.msgid === 6228 && m.payload.roomId === table.roomId);
  assert.deepEqual(updates.map(m => m.payload.customData).sort(), [1, 2]);
  assert.equal(f.messages.slice(start).some(m => [6204, 6208, 6212].includes(m.msgid) && m.payload.roomType === 50), false);
  const area = Object.entries(table.hand.areaOdds || table.rules.betAreaOdds).find(([, odds]) => odds > 0)[0];
  table.state = 2; table.phaseEndsAt = Date.now() + 10000;
  await f.send(6125, { roomType: 50, roomId: table.roomId, params: [{ areaId: Number(area), total: 100 }] });
  assert.equal(f.messages.findLast(m => m.msgid === 6226).payload.customData, 1);
  assert.equal(f.messages.findLast(m => m.msgid === 6226).payload.code, 0);
  await f.send(6124, { mulRoomTypeList: [{ roomType: 50 }], customData: 1 });
  assert.deepEqual(hundredContexts(f.session, table), [2]);
  await f.send(6124);
  assert.deepEqual([...f.session.hundredRoomIds], [f.main.roomId]);
  assert.equal(f.main.visitors.has(971), true); assert.equal(table.visitors.has(971), false);
  assert.equal(table.playerSessions.has(971), true, 'unsettled bets retain their owner after unsubscribe');
  assert.equal(f.session.inRoom, true); assert.equal(f.session.hundredInRoom, true);
});

test('unsubscribed, wrong-type and another agent targets reject before debit; socket close clears every subscription', async () => {
  const f = await fixture();
  await f.send(6126, { roomType: 58 });
  const roomId = f.messages.findLast(m => m.msgid === 6230).payload[0].roomId;
  const bet = type => f.send(6125, { roomType: type, roomId, params: [{ areaId: 1, total: 100 }] });
  await bet(58); assert.equal(f.messages.at(-1).payload.code, 95041);
  await f.send(6123, { roomType: 58, roomIds: [roomId], customData: 2 });
  await bet(50); assert.equal(f.messages.at(-1).payload.code, 95041);
  const table = f.registry.getTable(roomId, 7, 'baccarat');
  f.registry.removeTable(roomId, 7, 'baccarat'); f.registry.setTable(roomId, table, 8, 'baccarat');
  await bet(58); assert.equal(f.messages.at(-1).payload.code, 95041);
  assert.equal(f.session.wallet, 1000000);
  f.registry.removeTable(roomId, 8, 'baccarat'); f.registry.setTable(roomId, table, 7, 'baccarat');
  await bet(58); assert.equal(f.session.wallet, 999900);
  await f.handler.onClose(f.ws);
  assert.equal(f.registry.session(f.ws), null);
  assert.ok([...f.registry.tables.values()].every(t => !t.visitors?.has(971)));
  assert.equal(table.playerSessions.has(971), true);
  table.lastResult = { areas: [1], player: [1, 2], banker: [3, 4], p: 5, b: 9 };
  await applyCycle({ wallet: f.runtime.wallet, forEachPlayer() {}, sendUser() {} }, table, 6);
  assert.equal(f.session.wallet, 1000100); assert.equal(table.playerSessions.has(971), false);
});

test('Dragon Tiger registration and discovery project settled snapshots without changing the main peek response', async () => {
  const f = await fixture(59), table = f.main;
  table.state = 6; table.phaseEndsAt = Date.now() + 10000;
  table.lastResult = { showdownPokers: { dragon: [12], tiger: [0] },
    showdownTypes: { dragon: 13, tiger: 1 }, d: 13, t: 1, areas: [1, 4, 6, 8, 10, 15], settled: true };
  await f.send(6123, { roomType: 59, roomIds: [table.roomId], customData: 2 });
  const registered = f.messages.findLast(m => m.msgid === 6227).payload.roomInfos[0];
  assert.equal(registered.state, 6); assert.equal(Object.hasOwn(registered, 'showdownPoints'), false);
  assert.deepEqual(registered.showdownTypes, { dragon: 13, tiger: 1 });
  await f.send(6126, { roomType: 59 });
  const discovered = f.messages.findLast(m => m.msgid === 6230).payload.find(r => r.roomId === table.roomId);
  assert.equal(Object.hasOwn(discovered, 'showdownPoints'), false);
  assert.deepEqual(discovered.showdownTypes, registered.showdownTypes);
  await f.send(6105, { roomType: 59, roomId: table.roomId, playMode: table.playMode });
  assert.deepEqual(f.messages.findLast(m => m.msgid === 6205).payload.showdownPoints,
    { dragon: [13], tiger: [1] });
});
