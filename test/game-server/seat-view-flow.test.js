import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry } from '../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { SEND, PUSH } from '../../game-server/src/messages.js';
import { ZjhGame } from '../../game-server/src/games/zjh/ZjhGame.js';
import { NiuniuGame } from '../../game-server/src/games/niuniu/NiuniuGame.js';

for (const Game of [ZjhGame, NiuniuGame]) {
  test(`${Game.name}: observer wire view survives reload, live join, seat requests and settlement`, async () => {
    const game = new Game(), registry = createRegistry(), roomType = game.roomTypes[0];
    const row = { game_room_config_id: 45, play_mode: 3, ante: 10, carry_min: 1000,
      payload: JSON.stringify({ randomSit: false }), robot_behavior: { joinProbability: 0, leaveProbability: 0 } };
    const table = game.createTable(780000 + roomType, roomType, row);
    table.members = [{ uid: 11, pos: 2, point: 10000, state: 2, name: 'a' },
      { uid: 12, pos: 6, point: 10000, state: 2, name: 'b' }];
    registry.setTable(table.roomId, table, 7, game.id);
    const runtime = { registry, hotVersion: 'view-before', configs: [], findConfig: () => row,
      gateway: { async getLoginData() { return { agentId: 7 }; } },
      wallet: { async load(s) { s.wallet = 10000; }, async persist() {},
        debit(s, n) { s.wallet -= n; return { ok: true }; },
        credit(s, n) { s.wallet += n; return { ok: true }; } },
      log: { info() {}, error(...args) { assert.fail(args.join(' ')); } } };
    let handler = await createHandler(runtime);
    const peer = uid => { const messages = []; return { uid, messages, ws: { readyState: 1, send(raw) { messages.push(decodeFrame(raw)); } } }; };
    const a = peer(99), b = peer(100), player = peer(11);
    const request = (p, id, body) => handler.onMessage(p.ws, encodeFrame(id, body));
    const enter = async p => {
      await request(p, SEND.ROOM_LOGIN, { userId: p.uid, roomId: table.roomId });
      await request(p, SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType });
      await request(p, SEND.LOGIN_ROOM);
    };
    await enter(a); await enter(player);
    const roomInfo = p => p.messages.findLast(m => m.msgid === PUSH.ROOM_INFO).payload;
    assert.equal(roomInfo(a).memberList[0].userInfo.uid, 11);
    assert.equal(table.members[0].pos, 2);
    const offset = registry.session(a.ws).seatView.offset;
    runtime.hotVersion = 'view-after';
    handler = await createHandler(runtime);
    assert.equal(registry.session(a.ws).seatView.offset, offset);
    table.startAt = 0;
    table.phase = 'starting';
    await handler.tick();
    assert.ok(table.hand);
    await enter(b);
    const live = b.messages.findLast(m => m.msgid === 3260).payload;
    assert.equal(roomInfo(b).memberList[0].userInfo.uid, 11);
    assert.deepEqual(live.memberDeskInfos.map(m => m.pos), [0, 4]);
    if (game.id === 'niuniu') {
      assert.ok(live.memberDeskInfos.every(m => m.niuInfo.cardList.length === 0));
    } else {
      assert.ok(live.memberDeskInfos.every(m => m.handPais.every(c => c === -1)));
      assert.ok(!b.messages.some(m => m.msgid === 3726));
    }
    assert.ok(!table.members.some(m => [99, 100].includes(m.uid)));
    // Disable random sit to prove client position 1 reserves real position 3.
    await request(a, SEND.SEND_SITDOWN, { position: 1 });
    const member = table.members.find(m => m.uid === 99);
    assert.equal(member.pos, 3);
    assert.equal(roomInfo(a).memberList[1].userInfo.uid, 99);
    await request(a, SEND.SEND_CARRY_SCORE, { carryIn: 10 });
    assert.equal(member.point, 1000);
    assert.equal(table.hand.players?.some(p => p.uid === 99) || table.hand.participants?.some(p => p.uid === 99) || false, false);
    const handPositions = (table.hand.players || table.hand.participants).map(p => p.pos);
    assert.deepEqual(handPositions, [2, 6]);
    if (game.id === 'niuniu') {
      await request(player, 3405, { count: 0 });
      const p2 = peer(12); await enter(p2); await request(p2, 3405, { count: 0 });
      await handler.tick();
      // Tick the isolated engine through its public deadlines, preserving the
      // real handler's transport for settlement and authorized card delivery.
      let now = Date.now() + 100000;
      const originalNow = Date.now;
      try {
        Date.now = () => now;
        for (let i = 0; i < 5 && table.hand; i++) { await handler.tick(); now += 100000; }
      } finally { Date.now = originalNow; }
    } else {
      const actor = table.hand.actorUid === 11 ? player : peer(12);
      if (actor !== player) await enter(actor);
      await request(actor, 3562, { operation: 2 });
    }
    assert.equal(table.hand, null);
    const resultId = game.id === 'niuniu' ? 3610 : 3732;
    const result = b.messages.findLast(m => m.msgid === resultId).payload;
    assert.deepEqual(result.map(p => p.pos).sort((a, b) => a - b), [0, 4]);
    assert.equal(result.reduce((n, p) => n + p.score, 0), 0);
    assert.deepEqual(table.members.filter(m => [11, 12].includes(m.uid)).map(m => m.pos), [2, 6]);
    await request(a, SEND.SEND_STANDUP);
    assert.ok(!table.members.some(m => m.uid === 99));
    assert.ok(table.observers.some(m => m.uid === 99));
  });
}
