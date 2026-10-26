import assert from "node:assert/strict";
import test from "node:test";
import { beginHand, createTexasTable, onTexasAction, pushPlayingSnapshot,
  texasConf, texasHistoryDetail, texasHistoryPayload, texasRoomInfo } from "../../../../game-server/src/games/holdem/engine.js";
import holdem from "../../../../game-server/src/games/holdem/HoldemGame.js";
import { fairCodeDetail } from "../../../../game-server/src/core/fair-code.js";
import { OP } from "../../../../game-server/src/games/holdem/op.js";
import { PUSH, SEND } from "../../../../game-server/src/messages.js";

function fixture(show = false, stacks = [2000, 2000, 2000]) {
  const cfg = { room_type: 19, game_room_config_id: show ? 70 : 1924, play_mode: 0,
    small_blind: 10, big_blind: 20, carry_min: 500, force_show_card: Number(show) };
  const table = createTexasTable(cfg.game_room_config_id * 10000, 19, cfg);
  table.members = stacks.map((point, pos) => ({ uid: pos + 1, name: 'player-' + pos,
    pos, point, state: 1, bot: false }));
  table.observers = [{ uid: 99, name: 'observer' }];
  const messages = [];
  const io = { env: 'dev', broadcast(msgid, payload) { messages.push({ msgid, payload }); },
    send(uid, msgid, payload) { messages.push({ uid, msgid, payload }); },
    sendUser(uid, msgid, payload) { messages.push({ uid, msgid, payload }); },
    forEachPlayer(fn) { for (const uid of [1, 2, 3, 99]) fn({ userId: uid, ws: uid }); } };
  beginHand(io, table);
  return { table, io, messages };
}

function act(f, operation) {
  const uid = f.table.hand.actorUid;
  onTexasAction(f.io, f.table, { userId: uid }, { uid, operation, operationData: 0 });
}

function finish(f) {
  for (let count = 0; f.table.hand && count < 40; count++) {
    const p = f.table.members.find((p) => p.uid === f.table.hand.actorUid);
    act(f, p.streetBet < f.table.hand.currentBet ? OP.FOLLOW : OP.PASS);
  }
  assert.equal(f.table.hand, null);
  return f.messages.find((m) => m.msgid === PUSH.DZPK_INNING_RESULT_PUSH).payload;
}

test('normal no-show and forced-show use the shared game and consistent protocol config', () => {
  for (const show of [false, true]) {
    const f = fixture(show);
    const fresh = holdem.createTable(f.table.roomId, 19, f.table.cfg);
    for (const info of [texasConf(f.table), texasRoomInfo(f.table), holdem.buildConf(fresh), holdem.roomInfo(fresh)]) {
      assert.equal(info.playMode, 1);
      assert.equal(info.dzpk.forceShowCard, show);
      assert.equal(info.dzpk.forceShowType, 1);
      assert.equal(info.dzpk.delayLook, true);
      assert.equal(info.dzpk.initialBet, 20);
      assert.equal(info.dzpk.gameTime, 28800);
    }
  }
});

test('deal, hand request and reconnect expose only the caller holes', () => {
  const f = fixture();
  for (const uid of [1, 2, 99]) {
    const dealt = f.messages.find((m) => m.uid === uid && m.msgid === PUSH.DZPK_DEAL_DI_PUSH).payload;
    for (const p of dealt) assert.deepEqual(p.cardList, p.uid === uid
      ? f.table.members.find((m) => m.uid === uid).hole : [-1, -1]);
    const received = [];
    const ctx = { table: f.table, session: { userId: uid }, send(msgid, payload) { received.push({ msgid, payload }); } };
    assert.equal(holdem.onMessage(ctx, SEND.DZPK_HAND_CARD_REQ, { uid: 1 }), true);
    assert.equal(received[0].msgid, 3282);
    assert.deepEqual(received[0].payload.handCard, f.table.members.find((m) => m.uid === uid)?.hole || [-1, -1]);
    pushPlayingSnapshot(ctx.send, f.table, ctx.session);
    for (const p of received.at(-1).payload.memberDeskInfos) assert.deepEqual(p.handPais,
      p.uid === uid ? f.table.members.find((m) => m.uid === uid).hole : [-1, -1]);
    assert.ok(Object.values(received.at(-1).payload.roundBetMap).every(Number.isFinite));
  }
  const actor = f.table.hand.actorUid;
  const pot = f.table.hand.pot;
  onTexasAction(f.io, f.table, { userId: 99 }, { uid: actor, operation: OP.ALL_IN });
  assert.equal(f.table.hand.actorUid, actor);
  assert.equal(f.table.hand.pot, pot);
});

test('uncontested no-show pot hides all holes in settlement, replay and observer fair code', () => {
  const f = fixture();
  act(f, OP.ABANDON);
  act(f, OP.ABANDON);
  const result = f.messages.find((m) => m.msgid === PUSH.DZPK_INNING_RESULT_PUSH).payload;
  assert.equal(result.reduce((s, p) => s + p.score, 0), 0);
  for (const row of result) {
    assert.deepEqual(row.showCards, []);
    assert.deepEqual(row.handPais, []);
    assert.equal(row.cardTypeInfo, undefined);
  }
  assert.equal(f.messages.some((m) => [3435, 3441].includes(m.msgid)), false);
  const replay = texasHistoryPayload(f.table).playBackList[0];
  for (const row of replay.firstGameList) {
    assert.deepEqual(row.showCards, [-1, -1]);
    assert.deepEqual(row.cards.slice(0, 2), [-1, -1]);
    assert.deepEqual(row.handPais, []);
    assert.ok(row.operateList.every((a) => a.cards == null || a.cards.every((c) => c === -1)));
  }
  const detail = texasHistoryDetail(f.table, 1).exploitsInfoMsgs[0];
  for (const row of JSON.parse(detail.inningResults)) {
    assert.equal(row.cardTypeInfo, undefined);
    assert.deepEqual(row.handPais, []);
  }
  assert.ok(detail.memberResults.every((row) => row.pais.length === 0));
  assert.equal(fairCodeDetail(f.table, 99, 1).pokerList.some((c) => c.secretKey), false);
  assert.equal(fairCodeDetail(f.table, 1, 1).pokerList.filter((c) => c.secretKey).length, 2);
});

test('contested no-show showdown reveals active players and exactly five evaluated cards', () => {
  const f = fixture();
  const folded = f.table.hand.actorUid;
  act(f, OP.ABANDON);
  const result = finish(f);
  for (const row of result) {
    if (row.uid === folded) {
      assert.deepEqual(row.handPais, []);
      assert.equal(row.cardTypeInfo, undefined);
    } else {
      assert.equal(row.showCards.length, 2);
      assert.equal(row.handPais.length, 5);
      assert.deepEqual(row.handPais, row.cardTypeInfo.handCardList);
    }
  }
  assert.equal(f.messages.filter((m) => m.msgid === 3441).length, 2);
  assert.equal(f.messages.some((m) => m.msgid === 3435), false);
  const replay = texasHistoryPayload(f.table).playBackList[0].firstGameList;
  assert.deepEqual(replay.find((p) => p.uid === folded).showCards, [-1, -1]);
  assert.ok(replay.filter((p) => p.uid !== folded).every((p) => p.handPais.length === 5));
});

test('forced-show keeps its original reveal behavior after a fold', () => {
  const f = fixture(true, [2000, 2000]);
  act(f, OP.ABANDON);
  const rows = f.messages.find((m) => m.msgid === 3432).payload;
  assert.ok(rows.every((p) => p.showCards.length === 2));
  assert.equal(f.messages.find((m) => m.msgid === 3435).payload.length, 2);
});

test('all-in runs out every public street before the settlement message', () => {
  const f = fixture(false, [1000, 1000]);
  act(f, OP.ALL_IN);
  act(f, OP.FOLLOW);
  assert.equal(f.table.hand, null);
  const events = f.messages.filter((m) => [3428, 3429, 3430, 3432].includes(m.msgid));
  assert.deepEqual(events.map((m) => m.msgid), [3428, 3429, 3430, 3432]);
  assert.equal(events[0].payload.cardList.length, 3);
  assert.equal(events[1].payload.cardList.length, 1);
  assert.equal(events[2].payload.cardList.length, 1);
  assert.equal(events[3].payload.reduce((sum, row) => sum + row.point, 0), 2000);
});

test('voluntary single-card selection stays private until settlement and never reveals its partner', () => {
  const f = fixture();
  const uid = f.table.hand.actorUid;
  const player = f.table.members.find((p) => p.uid === uid);
  const [card, hidden] = player.hole;
  const replies = [];
  const ctx = { table: f.table, session: { userId: uid }, send(msgid, payload) { replies.push({ msgid, payload }); } };
  for (const isShow of [true, false, true]) {
    assert.equal(holdem.onMessage(ctx, SEND.DZPK_SHOW_CARD_REQ, { card, isShow }), true);
    assert.deepEqual(replies.at(-1), { msgid: 3277, payload: { result: 0, card, isShow } });
  }
  holdem.onMessage(ctx, SEND.DZPK_SHOW_CARD_REQ, { card: 99, isShow: true });
  assert.equal(replies.at(-1).payload.result, 1);
  assert.equal(f.messages.some((m) => m.msgid === 3441), false);
  pushPlayingSnapshot(ctx.send, f.table, ctx.session);
  assert.deepEqual(replies.at(-1).payload.memberDeskInfos.find((p) => p.uid === uid).showCards, [card, -1]);
  act(f, OP.ABANDON);
  act(f, OP.ABANDON);
  const row = f.messages.find((m) => m.msgid === 3432).payload.find((p) => p.uid === uid);
  assert.deepEqual(row.showCards, [card, -1]);
  assert.equal(row.cardTypeInfo, undefined);
  assert.deepEqual(f.messages.find((m) => m.msgid === 3441).payload.cardList, [card, -1]);
  const replay = texasHistoryPayload(f.table).playBackList[0].firstGameList.find((p) => p.uid === uid);
  assert.deepEqual(replay.showCards, [card, -1]);
  assert.deepEqual(replay.cards.slice(0, 2), [card, -1]);
  assert.deepEqual(replay.handPais, []);
  const proof = fairCodeDetail(f.table, 99, 1).pokerList.filter((p) => p.secretKey);
  assert.deepEqual(proof.map((p) => JSON.parse(p.pokerInfo).index), [card]);
  assert.ok(!proof.some((p) => JSON.parse(p.pokerInfo).index === hidden));
});

test('unequal all-in stacks settle main and side pots separately', () => {
  const f = fixture(false, [500, 1000, 1000]);
  // Fixed hands test payout eligibility independently from shuffled luck.
  f.table.members[0].hole = [0, 13]; // aces win the main pot
  f.table.members[1].hole = [12, 25]; // kings win the side pot
  f.table.members[2].hole = [11, 24];
  f.table.hand.deck = [51, 1, 16, 31, 50, 7, 49, 22];
  f.table.hand.deckPos = 0;
  act(f, OP.ALL_IN);
  act(f, OP.ALL_IN);
  act(f, OP.FOLLOW);
  assert.equal(f.table.hand, null);
  const result = f.messages.find((m) => m.msgid === 3432).payload;
  assert.deepEqual(result.map((p) => [p.uid, p.point, p.score]), [[1, 1500, 1000], [2, 1000, 0], [3, 0, -1000]]);
  assert.deepEqual(f.messages.filter((m) => m.msgid === 3434).at(-1).payload, [1500, 1000]);
  assert.equal(result.reduce((sum, p) => sum + p.score, 0), 0);
});

test('departed folded bets remain in payout and history without crediting the departed wallet twice', () => {
  const f = fixture(false, [1000, 1000, 1000]);
  const uid = f.table.hand.actorUid;
  const leaver = f.table.members.find((p) => p.uid === uid);
  const committed = leaver.totalBet;
  const session = { userId: uid, wallet: 0 };
  const returned = holdem.onLeave({ table: f.table, io: f.io, session });
  assert.equal(returned, 1000 - committed);
  assert.equal(f.table.members.some((p) => p.uid === uid), false);
  const result = finish(f);
  assert.equal(result.find((p) => p.uid === uid).score, -committed);
  assert.equal(f.table.members.reduce((sum, p) => sum + p.point, returned), 3000);
  assert.ok(texasHistoryPayload(f.table).playBackList[0].firstGameList.some((p) => p.uid === uid));
});
