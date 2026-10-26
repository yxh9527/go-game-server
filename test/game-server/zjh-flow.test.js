import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createRoomPool } from '../../game-server/src/core/room-pool.js';
import zjh from '../../game-server/src/games/zjh/ZjhGame.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { SEND, PUSH } from '../../game-server/src/messages.js';
import { ZJH_SEND, ZJH_PUSH, ZJH_OP } from '../../game-server/src/games/zjh/messages.js';

test('Zjh binary flow: spectator, seat, carry, circle, reconnect, hot reload, settle, replay and exit', async () => {
  const configs = seedRooms(), registry = createRegistry();
  const runtime = { env: 'dev', registry, configs, findConfig, hotVersion: 'zjh-before',
    gateway: { async getLoginData(userId) { return { userId, agentId: 7, userName: 'player-' + userId }; } },
    wallet: { async load(s) { s.wallet = 10000; }, async persist() {},
      debit(s, amount) { if (s.wallet < amount) return { ok: false }; s.wallet -= amount; return { ok: true }; },
      credit(s, amount) { s.wallet += amount; return { ok: true }; } },
    log: { info() {}, error(...args) { assert.fail(args.join(' ')); } } };
  let handler = await createHandler(runtime);
  const pool = createRoomPool(runtime, () => zjh);
  const row = configs.find((c) => c.game_room_config_id === 2501);
  const allocation = pool.allocate(7, row), table = registry.getTable(allocation.roomId, 7, 'zjh');
  const createdAt = table.createdAt;
  table.cfg.robot_behavior = { joinProbability: 0, leaveProbability: 0 };
  const peers = [101, 102, 199].map((uid) => {
    const messages = [];
    return { uid, messages, ws: { readyState: 1, send(raw) { messages.push(decodeFrame(raw)); } } };
  });
  const request = (peer, id, payload) => handler.onMessage(peer.ws, encodeFrame(id, payload));
  for (const peer of peers) {
    await request(peer, SEND.ROOM_LOGIN, { userId: peer.uid, roomId: table.roomId });
    await request(peer, SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType: 25 });
    await request(peer, SEND.LOGIN_ROOM, { roomId: table.roomId });
    const conf = peer.messages.find((m) => m.msgid === PUSH.ROOM_TYPE_RESULT).payload.conf;
    assert.equal(conf.ctjhParams.ante, 10);
    assert.equal(conf.playMode, 3);
    assert.equal(conf.ctjhParams.gameTime, 28800);
    assert.ok(table.observers.some((p) => p.uid === peer.uid));
    assert.ok(!table.members.some((p) => p.uid === peer.uid));
  }
  for (const [pos, peer] of peers.slice(0, 2).entries()) {
    await request(peer, SEND.SEND_SITDOWN, { position: pos });
    const seat = table.members.find((p) => p.uid === peer.uid);
    assert.equal(seat.point, 0);
    assert.ok(seat.carryDeadline - Date.now() <= 12000);
    await request(peer, SEND.SEND_CARRY_SCORE, { carryIn: 10 });
    assert.equal(seat.point, 1000);
  }
  table.startAt = 0;
  await handler.tick();
  const hand = table.hand;
  const act = (operation, extra = {}) => request(peers.find((p) => p.uid === hand.actorUid), ZJH_SEND.ACTION, { operation, ...extra });
  await act(ZJH_OP.CALL, { operationData: 0.1 });
  await act(ZJH_OP.CALL, { operationData: 0.1 });
  assert.equal(hand.round, 2);
  await act(ZJH_OP.LOOK);
  const actor = peers.find((p) => p.uid === hand.actorUid);
  await request(actor, ZJH_SEND.HAND_CARD);
  assert.equal(actor.messages.at(-1).payload.handCard.length, 3);
  assert.ok(!peers[2].messages.some((m) => m.msgid === ZJH_PUSH.SEE_CARD || m.msgid === ZJH_PUSH.OPERATION));
  runtime.hotVersion = 'zjh-after';
  handler = await createHandler(runtime);
  assert.equal(table.hand, hand);
  assert.equal(table.createdAt, createdAt);
  assert.equal(pool.allocate(7, row).roomId, table.roomId);
  await request(actor, SEND.LOGIN_ROOM);
  const snap = actor.messages.findLast((m) => m.msgid === PUSH.NIUNIU_INNING_BEGIN_INFO).payload;
  assert.equal(snap.currentOperatorId, hand.actorUid);
  assert.equal(snap.pot, 40);
  await act(ZJH_OP.COMPARE, { targetUid: peers.find((p) => p.uid !== hand.actorUid && p.uid !== 199).uid, operationData: 0 });
  assert.equal(table.hand, null);
  const settlement = actor.messages.find((m) => m.msgid === ZJH_PUSH.INNING_RESULT).payload;
  assert.equal(settlement.reduce((sum, p) => sum + p.score, 0), 0);
  assert.ok(settlement.every((p) => p.handPais.length === 3 && p.icon));
  await request(peers[2], ZJH_SEND.GAME_BACK, { roomId: table.roomId, beginNum: 0, endNum: 0 });
  const history = peers[2].messages.at(-1).payload;
  assert.equal(history.totalNum, 1);
  assert.equal(history.playBackList[0].firstGameList.length, 2);
  assert.ok(handler.getDevHoldemRecordDetail(table.roomId, 1, 199, 7));
  assert.equal(handler.getDevHoldemRecordDetail(table.roomId, 1, 999, 7), null);
  assert.equal(handler.getDevHoldemRecordDetail(table.roomId, 1, 199, 8), null);
  for (const peer of peers) await request(peer, SEND.SEND_LEVEL_OUT);
  assert.equal(peers.reduce((sum, p) => sum + registry.session(p.ws).wallet, 0), 30000);
  assert.equal(table.members.length, 0);
  assert.equal(table.observers.length, 0);
  assert.equal(table.roomFeatures.players.get(101).totalHands, 1);
  assert.ok(peers.every((p) => p.messages.at(-1).msgid === PUSH.USER_LEVEL_ROOM));
});
