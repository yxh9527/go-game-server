import assert from 'node:assert/strict';
import test from 'node:test';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createRoomPool } from '../../game-server/src/core/room-pool.js';
import holdem from '../../game-server/src/games/holdem/HoldemGame.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { OP } from '../../game-server/src/games/holdem/op.js';
import { SEND, PUSH } from '../../game-server/src/messages.js';

test('no-show binary flow shares seats, buy-in, settlement, replay and exit across hot loading', async () => {
  const registry = createRegistry();
  const configs = seedRooms();
  const runtime = { env: 'dev', registry, configs, findConfig, hotVersion: 'no-show-before',
    gateway: { async getLoginData(userId) { return { userId, agentId: 7, userName: 'player-' + userId }; } },
    wallet: { async load(s) { s.wallet = 10000; }, async persist() {},
      debit(s, amount) { if (s.wallet < amount) return { ok: false }; s.wallet -= amount; return { ok: true }; },
      credit(s, amount) { s.wallet += amount; return { ok: true }; } },
    log: { info() {}, error(...args) { assert.fail(args.join(' ')); } } };
  let handler = await createHandler(runtime);
  const pool = createRoomPool(runtime, () => holdem);
  const show = pool.allocate(7, configs.find((c) => c.game_room_config_id === 70));
  const noShow = pool.allocate(7, configs.find((c) => c.game_room_config_id === 1924));
  assert.notEqual(show.roomId, noShow.roomId);
  assert.equal(noShow.playMode, 1);
  const table = registry.getTable(noShow.roomId, 7, 'holdem');
  const createdAt = table.createdAt;
  table.cfg.robot_behavior = { joinProbability: 0, leaveProbability: 0 };
  const peers = [101, 102, 199].map((uid) => {
    const messages = [];
    return { uid, messages, ws: { readyState: 1, send(raw) { messages.push(decodeFrame(raw)); } } };
  });
  const request = (peer, id, payload) => handler.onMessage(peer.ws, encodeFrame(id, payload));
  for (const peer of peers) {
    await request(peer, SEND.ROOM_LOGIN, { userId: peer.uid, roomId: table.roomId });
    await request(peer, SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType: 19 });
    const conf = peer.messages.find((m) => m.msgid === PUSH.ROOM_TYPE_RESULT).payload.conf;
    assert.equal(conf.playMode, 1);
    assert.equal(conf.dzpkParams.forceShowCard, false);
    assert.ok(table.observers.some((p) => p.uid === peer.uid));
    assert.ok(!table.members.some((p) => p.uid === peer.uid));
  }
  for (const [pos, peer] of peers.slice(0, 2).entries()) {
    await request(peer, SEND.SEND_SITDOWN, { position: pos });
    const seat = table.members.find((p) => p.uid === peer.uid);
    assert.equal(seat.point, 0);
    assert.ok(seat.carryDeadline - Date.now() <= 12000);
    assert.equal(registry.session(peer.ws).wallet, 10000);
    await request(peer, SEND.SEND_CARRY_SCORE, { carryIn: 10 });
    assert.equal(seat.point, 1000);
    assert.equal(registry.session(peer.ws).wallet, 9000);
  }
  table.startAt = 0;
  await handler.tick();
  assert.equal(table.phase, 'playing');
  const hand = table.hand;
  const actor = peers.find((p) => p.uid === hand.actorUid);
  await request(actor, SEND.DZPK_HAND_CARD_REQ);
  assert.deepEqual(actor.messages.at(-1).payload.handCard, table.members.find((p) => p.uid === actor.uid).hole);
  assert.ok(!peers[2].messages.some((m) => m.msgid === PUSH.DZPK_HAND_CARD_RES));
  assert.ok(!peers[2].messages.some((m) => m.msgid === PUSH.DZPK_OPERATION_PUSH));
  runtime.hotVersion = 'no-show-after';
  handler = await createHandler(runtime);
  assert.equal(table.hand, hand);
  assert.equal(table.createdAt, createdAt);
  assert.equal(pool.allocate(7, configs.find((c) => c.game_room_config_id === 1924)).roomId, table.roomId);
  await request(actor, SEND.DZPK_SEND_ACTION, { operation: OP.ABANDON });
  assert.equal(table.hand, null);
  for (const peer of peers) {
    const result = peer.messages.find((m) => m.msgid === PUSH.DZPK_INNING_RESULT_PUSH).payload;
    assert.equal(result.reduce((sum, p) => sum + p.score, 0), 0);
    assert.ok(result.every((p) => p.showCards.length === 0 && !p.cardTypeInfo));
  }
  await request(peers[2], SEND.DZPK_SEND_GAME_BACK_REQ, { roomId: table.roomId, beginNum: 0, endNum: 0 });
  const history = peers[2].messages.at(-1).payload;
  assert.equal(history.totalNum, 1);
  assert.equal(history.playBackList[0].firstGameList.length, 2);
  assert.ok(history.playBackList[0].firstGameList.every((p) => p.showCards.every((c) => c === -1)));
  assert.equal(table.roomFeatures.totalHands, 1);
  for (const peer of peers) await request(peer, SEND.SEND_LEVEL_OUT);
  assert.equal(peers.reduce((sum, p) => sum + registry.session(p.ws).wallet, 0), 30000);
  assert.equal(table.members.length, 0);
  assert.equal(table.observers.length, 0);
  assert.equal(table.createdAt, createdAt);
  assert.equal(table.roomFeatures.players.get(101).totalHands, 1);
  assert.ok(peers.every((p) => p.messages.at(-1).msgid === PUSH.USER_LEVEL_ROOM));
});
