import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { HundredBlackjackGame } from '../../../../game-server/src/games/hundred-blackjack/HundredBlackjackGame.js';
import * as cards from '../../../../game-server/src/games/hundred-blackjack/hand.js';
import * as engine from '../../../../game-server/src/games/hundred-blackjack/engine.js';
import { roomRules } from '../../../../game-server/src/games/hundred-blackjack/config.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../../game-server/src/codec.js';
import { SEND } from '../../../../game-server/src/messages.js';
const card = rank => rank - 1;
function fixture() {
  const game = new HundredBlackjackGame(), row = seedRooms().find(r => r.room_type === 60);
  const table = game.createTable(60010000, 60, row), session = { userId: 11, wallet: 1000000 }, messages = [];
  table.visitors.add(11); table.playerSessions.set(11, session);
  const io = { broadcast: (id, data) => messages.push({ id, data: structuredClone(data) }),
    sendUser: (uid, id, data) => messages.push({ uid, id, data: structuredClone(data) }),
    forEachPlayer: fn => fn(session) };
  const runtime = { wallet: { debit(s, n) { s.wallet -= n; return { ok: true }; },
    credit(s, n) { s.wallet += n; return { ok: true }; } } };
  const ctx = { game, table, session, io, runtime, send: (id, data) => io.sendUser(11, id, data) };
  const start = () => { engine.beginRound(io, table, Date.now(), () => 0.42); table.state = 2; table.phaseEndsAt = Date.now() + 20000; };
  return { game, row, table, session, messages, io, ctx, start };
}
test('hundred rules admit only the captured mode and bound the cut card', () => {
  assert.equal(roomRules().playMode, 0); assert.equal(roomRules().cutIndex, 262);
  assert.throws(() => roomRules({ play_mode: 1 }), /Unsupported/);
  for (const cutIndex of [0, 7, 293, 312, NaN]) assert.throws(() => roomRules({ payload: { cutIndex } }), /cutIndex/);
});
test('original help ranks Blackjack above five-dragon, ordinary and bust; identical specials and both bust tie', () => {
  const bj = [card(1), card(10)], five = [card(1), card(2), card(3), card(4), card(5)];
  const normal = [card(10), card(7)], bust = [card(10), card(10), card(5)];
  assert.equal(cards.evaluate(bj).cardType, 3); assert.equal(cards.evaluate(five).cardType, 2);
  assert.equal(cards.compare(bj, five), 1); assert.equal(cards.compare(five, normal), 1);
  assert.equal(cards.compare(normal, bust), 1); assert.equal(cards.compare(bust, [9, 9, 9]), 0);
  assert.equal(cards.compare(bj, [13, 22]), 0); assert.equal(cards.compare(five, [0, 0, 0, 0, 0]), 0);
  assert.deepEqual(cards.evaluate([0, 5]), { point: 7, pointAlt: 17, finalPoint: 17, cardType: 1 });
  assert.throws(() => cards.evaluate([-1, 10]), /Invalid/);
});
test('captured result reproduces all three area pairs including the both-bust push', () => {
  const banker = [27, 16, 37, 20];
  assert.equal(cards.evaluate(banker).finalPoint, 24);
  assert.equal(cards.compare([23, 6], banker), 1);
  assert.equal(cards.compare([17, 45, 37], banker), 0);
  assert.equal(cards.compare([48, 35], banker), 1);
});
test('thousandth prices settle as integer points, while ties refund the full stake', () => {
  const hand = { winningAreas: [1], tieAreas: [2] };
  assert.equal(cards.betNet(hand, { areaId: 1, total: 100 }, { 1: 1.14 }), 114);
  assert.equal(cards.betNet(hand, { areaId: 1, total: 100 }, { 1: 0.29 }), 29);
  assert.equal(cards.betNet(hand, { areaId: 2, total: 100 }, { 2: 9 }), 0);
  assert.equal(cards.betNet(hand, { areaId: 4, total: 100 }, { 4: 9 }), -100);
});
test('a six-pack shoe persists between rounds, exposes one card and supplies every animation field', () => {
  const f = fixture(); f.start(); const shoe = f.table.blackjackShoe, first = f.table.hand;
  assert.equal(shoe.cards.length, 312);
  for (let id = 0; id < 52; id++) assert.equal(shoe.cards.filter(c => c === id).length, 6);
  const snapshot = engine.roomSnapshot(f.table, f.session);
  for (const key of cards.positions) {
    assert.deepEqual(snapshot[key + 'Cards'], [first.cards[key][0], -1]);
    assert.deepEqual(snapshot.showdownPokers[key], [first.cards[key][0], -1]);
    const info = first.blackJackAreaInfos.find(i => i.area === key);
    assert.equal(info.supplySteps.length, info.finalCards.length - 2);
    for (const value of [info.firstPoint, info.firstPointAlt, info.finalPoint]) assert.ok(Number.isFinite(value));
    assert.ok(info.finalPoint >= 17 || info.finalCards.length === 5);
    info.supplySteps.forEach((step, i) => assert.deepEqual({ point: step.point, pointAlt: step.pointAlt, cardType: step.cardType },
      ((r) => ({ point: r.point, pointAlt: r.pointAlt, cardType: r.cardType }))(cards.evaluate(info.finalCards.slice(0, i + 3)))));
  }
  assert.equal(snapshot.dealCardCount, 8); assert.equal(snapshot.remainCardsNum, 304);
  assert.equal(snapshot.blackJackAreaInfos, undefined, 'initial snapshots cannot leak hidden cards');
  const second = cards.createHand(f.table);
  assert.equal(f.table.blackjackShoe, shoe); assert.equal(second.shoeStart, first.shoeEnd);
});
test('prices use public composition rather than secret card order and freeze for the hand', () => {
  const f = fixture(); cards.newShoe(f.table, () => 0.42);
  const h = cards.createHand(f.table), other = structuredClone(h);
  other.pricingPool.reverse(); other.cards.a[1] = (other.cards.a[1] + 1) % 52;
  cards.prepareRound(f.table, h); cards.prepareRound(f.table, other);
  assert.deepEqual(h.areaOdds, other.areaOdds);
  for (const odds of Object.values(h.areaOdds)) assert.ok(Number.isFinite(odds) && odds > 0);
  assert.throws(() => cards.conditionalOdds(cards.visibleCards(h), [], 1024), /Missing/);
  assert.throws(() => cards.conditionalOdds(cards.visibleCards(h), cards.makeShoe(), 1e9), /sample/);
});
test('opposite bets, malformed amounts, cumulative limits and stale clocks reject before debit', () => {
  const f = fixture(); f.start(); f.table.rules.maxBet = 1000;
  const bet = params => engine.acceptBet(f.ctx, { roomType: 60, roomId: f.table.roomId, params });
  for (const params of [[{ areaId: 1, total: 100 }, { areaId: 4, total: 100 }],
    [{ areaId: 7, total: 100 }], [{ areaId: 1, total: NaN }], [{ areaId: 1, total: 1.5 }],
    [{ areaId: 1, total: 600 }, { areaId: 1, total: 600 }]]) assert.equal(bet(params), false);
  assert.equal(f.session.wallet, 1000000); assert.equal(f.table.playerBets.size, 0);
  assert.equal(bet([{ areaId: 1, total: 100 }]), true);
  assert.equal(bet([{ areaId: 4, total: 100 }]), false);
  f.table.phaseEndsAt = Date.now() - 1;
  assert.equal(bet([{ areaId: 2, total: 100 }]), false); assert.equal(f.session.wallet, 999900);
});
test('settlement refunds ties, sends personal 6208 before state 6 and records authorized review data', async () => {
  const f = fixture(); f.start(); const areaId = f.table.hand.winningAreas[0] || f.table.hand.tieAreas[0];
  const odds = f.table.hand.areaOdds[areaId];
  assert.equal(engine.acceptBet(f.ctx, { roomType: 60, params: [{ areaId, total: 10000 }] }), true);
  f.table.rules.betAreaOdds = Object.fromEntries(cards.areaIds.map(id => [id, 999]));
  const expected = f.table.hand.tieAreas.includes(areaId) ? 0 : Math.floor(10000 * odds);
  const start = f.messages.length; await engine.settleRound(f.ctx);
  assert.equal(f.session.wallet, 1000000 + expected);
  const sent = f.messages.slice(start), personal = sent.find(m => m.id === 6208 && m.uid === 11).data;
  assert.equal(personal.realScore, expected); assert.equal(personal.blackJackAreaInfos.length, 4);
  assert.ok(sent.findIndex(m => m.id === 6208) < sent.findIndex(m => m.id === 6204 && m.data.state === 6));
  assert.equal(personal.lostAreas.some(id => personal.tieAreas.includes(id)), false);
  const detail = engine.historyDetail(f.table, 11, 1);
  assert.deepEqual(detail.blackJackAreaInfos, personal.blackJackAreaInfos);
  assert.equal(detail.betDetailTableMap[areaId].realScore, expected);
  detail.blackJackAreaInfos[0].finalCards.pop();
  assert.notDeepEqual(engine.historyDetail(f.table, 11, 1), detail);
  assert.equal(engine.historyDetail(f.table, 12, 1), null);
  const snap = engine.roomSnapshot(f.table, f.session);
  assert.equal(snap.realScore, expected); assert.equal(snap.areaWinningScores[areaId], expected);
  assert.equal(snap.remainCardsNum, 312 - f.table.blackjackShoe.cursor);
  assert.equal(await engine.settleRound(f.ctx), false);
  const hot = await import('../../../../game-server/src/games/hundred-blackjack/engine.js?v=settled');
  assert.equal(await hot.settleRound(f.ctx), false);
});
test('state sequence includes stop, full reveal and comparison, then clears bets before next deal', async t => {
  let now = 1800000000000; t.mock.method(Date, 'now', () => now);
  const f = fixture(); engine.tick(f.io, f.table, now, f.ctx);
  assert.equal(f.table.state, 1);
  const visited = [1];
  for (let i = 0; i < 10 && f.table.inning === 1; i++) {
    now = f.table.phaseEndsAt + 1; engine.tick(f.io, f.table, now, f.ctx);
    await Promise.resolve(); await Promise.resolve(); visited.push(f.table.state);
  }
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6, 7, 0]);
  assert.equal(f.table.inning, 2); assert.equal(f.table.hand, null);
  const result = f.messages.findIndex(m => m.id === 6208);
  assert.ok(result < f.messages.findIndex(m => m.id === 6204 && m.data.state === 4));
  assert.equal(f.messages.filter(m => m.id === 6204 && m.data.state === 0).length, 1);
});
test('cut card shuffles only between hands and suspends new betting until shuffle finishes', () => {
  const f = fixture(); cards.newShoe(f.table, () => 0.42); const old = f.table.blackjackShoe;
  old.cursor = old.cutIndex; engine.beginRound(f.io, f.table, 1000, () => 0.42);
  assert.equal(f.table.state, 8); assert.equal(f.table.hand, null);
  assert.notEqual(f.table.blackjackShoe, old); assert.equal(f.table.blackjackShoe.cursor, 0);
  assert.equal(f.messages.find(m => m.id === 6223).data.remainCardsNum, 312);
  engine.tick(f.io, f.table, 2000, f.ctx); assert.equal(f.table.hand, null);
  engine.tick(f.io, f.table, 4001, f.ctx); assert.equal(f.table.state, 1);
  assert.equal(f.table.hand.shoeStart, 0);
});
test('failed payout retries only unpaid players and preserves one road entry through hot reload', async () => {
  const f = fixture(); f.start(); const other = { userId: 12, wallet: 1000000 };
  f.table.playerSessions.set(12, other); f.table.visitors.add(12);
  const areaId = f.table.hand.winningAreas[0] || f.table.hand.tieAreas[0];
  for (const session of [f.session, other]) engine.acceptBet({ ...f.ctx, session }, { roomType: 60, params: [{ areaId, total: 100 }] });
  let failing = true; const paid = [];
  f.runtime = f.ctx.runtime; f.runtime.wallet.credit = (s, n) => {
    if (s.userId === 12 && failing) return { ok: false }; paid.push(s.userId); s.wallet += n; return { ok: true };
  };
  await assert.rejects(engine.settleRound(f.ctx)); assert.equal(f.table.hand.settled, undefined);
  failing = false; const hot = await import('../../../../game-server/src/games/hundred-blackjack/engine.js?v=retry');
  await hot.settleRound(f.ctx); assert.deepEqual(paid, [11, 12]);
  assert.equal(f.session.wallet, other.wallet); assert.equal(f.table.ways[2].ways.length, 1);
});
test('independent 60 login uses the ordinary 31 spectator host, registers mode 0 and isolates review and exit', async () => {
  const configs = seedRooms(), registry = createRegistry();
  const runtime = { env: 'dev', hotVersion: 'hundred-blackjack-test', configs, registry, findConfig,
    gateway: { validateToken: async () => true, getLoginData: async () => ({ agentId: 77, userName: 'player' }) },
    wallet: { load: async s => { s.wallet = 1000000; }, persist: async () => {},
      debit(s, n) { s.wallet -= n; return { ok: true }; }, credit(s, n) { s.wallet += n; return { ok: true }; } },
    log: { info() {}, error() {} } };
  const handler = await createHandler(runtime);
  const socket = () => { const frames = [], ws = { readyState: 1, send: raw => frames.push(decodeFrame(raw)) };
    return { ws, frames, send: (id, p) => handler.onMessage(ws, encodeFrame(id, p)) }; };
  const main = socket(), hundred = socket(), hostRow = configs.find(r => r.room_type === 31 && r.play_mode === 0);
  const login = { userId: 12, userToken: 'dev', roomId: hostRow.game_room_config_id * 10000, openHundredGame: true };
  await main.send(SEND.ROOM_LOGIN, login);
  await main.send(SEND.SEND_JOIN_ROOM, { roomId: login.roomId, roomType: 31, isOb: true, openHundredGame: true });
  const host = main.frames.find(f => f.msgid === 2201).payload;
  assert.equal(host.conf.hundredSwitch, true); assert.equal(host.roomType, 31);
  await hundred.send(SEND.ROOM_LOGIN, login); await hundred.send(SEND.ENTER, { roomType: 60 });
  await hundred.send(SEND.MB_REG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 60 }], customData: 2 });
  const rooms = hundred.frames.find(f => f.msgid === 6227).payload.roomInfos;
  assert.equal(rooms.length, 1); assert.equal(rooms[0].roomType, 60); assert.equal(rooms[0].playMode, 0);
  await hundred.send(SEND.GR_GET_ALL_ROOMS_REQ, { roomType: 60 });
  const mapping = hundred.frames.find(f => f.msgid === 6230).payload;
  assert.equal(mapping.length, 1); assert.equal(mapping[0].roomIndex, 0); assert.equal(mapping[0].roomType, 60);
  const session = registry.session(hundred.ws), table = registry.getTable(session.hundredRoomId, 77, 'hundred-blackjack');
  await handler.tick(); table.phaseEndsAt = Date.now() - 1; await handler.tick();
  await hundred.send(SEND.BET, { roomId: table.roomId, roomType: 60, params: [{ areaId: 1, total: 100 }] });
  assert.equal(hundred.frames.find(f => f.msgid === 6201).payload.code, 0);
  assert.equal(main.frames.some(f => f.msgid === 6228), false);
  await engine.settleRound({ table, runtime, io: { sendUser: (uid, id, p) => hundred.ws.send(encodeFrame(id, p)),
    broadcast() {}, forEachPlayer: fn => fn(session) } });
  await hundred.send(SEND.REQUEST_ONE_RECORD, { gameRoomId: table.roomId, currInning: 1 });
  assert.equal(hundred.frames.find(f => f.msgid === 6222).payload.blackJackAreaInfos.length, 4);
  const foreign = socket(); await foreign.send(SEND.ROOM_LOGIN, { ...login, userId: 13 });
  await foreign.send(SEND.ENTER, { roomType: 51, playMode: 1 });
  await foreign.send(SEND.REQUEST_ONE_RECORD, { gameRoomId: table.roomId, currInning: 1 });
  assert.equal(foreign.frames.some(f => f.msgid === 6222), false);
  await hundred.send(SEND.EXIT, { roomType: 60 });
  assert.equal(registry.session(main.ws).inRoom, true);
  assert.ok(registry.getTable(login.roomId, 77, 'blackjack').observers.some(p => p.uid === 12));
  assert.equal(table.visitors.has(12), false);
});
test('room discovery never scans or creates another agent room and does not subscribe the caller', () => {
  const f = fixture(), registry = createRegistry();
  f.table.agentId = 77; registry.setTable(f.table.roomId, f.table, 77, f.game.id);
  const foreign = f.game.createTable(99990000, 60, { ...f.row, game_room_config_id: 9999 });
  foreign.agentId = 88; registry.setTable(foreign.roomId, foreign, 88, f.game.id);
  const ctx = { ...f.ctx, session: { userId: 15, agentId: 77 },
    runtime: { configs: seedRooms(), registry } };
  f.game.onMessage(ctx, SEND.GR_GET_ALL_ROOMS_REQ, { roomType: 60 });
  const mappings = f.messages.find(m => m.id === 6230).data;
  assert.deepEqual(mappings.map(m => m.roomId), [60010000]);
  assert.equal(registry.tables.size, 2); assert.equal(ctx.session.hundredRoomIds, undefined);
  assert.equal(f.table.visitors.has(15), false);
});
