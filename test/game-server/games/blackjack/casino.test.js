import test from 'node:test';
import assert from 'node:assert/strict';
import { BlackjackGame } from '../../../../game-server/src/games/blackjack/BlackjackGame.js';
import * as engine from '../../../../game-server/src/games/blackjack/engine.js';
import { makeShoe } from '../../../../game-server/src/games/blackjack/hand.js';
import { DISPLAY_SEATS } from '../../../../game-server/src/games/blackjack/casino.js';
import { projectSeatMessage, restoreSeatRequest } from '../../../../game-server/src/core/seat-view.js';
import { createRegistry } from '../../../../game-server/src/registry.js';
import { createRoomPool } from '../../../../game-server/src/core/room-pool.js';
import { SEND, STATE } from '../../../../game-server/src/games/blackjack/messages.js';

function fixture() {
  const game = new BlackjackGame();
  const table = game.createTable(31100000, 31, { game_room_config_id: 3110, room_type: 31, play_mode: 1, ante: 100, carry_min: 0 });
  const messages = [];
  const io = { broadcast: (id, data) => messages.push({ id, data: structuredClone(data) }),
    sendUser: (uid, id, data) => messages.push({ uid, id, data: structuredClone(data) }),
    forEachPlayer: fn => [1, 2, 99].forEach(userId => fn({ userId })) };
  const session = { userId: 1, name: 'human', wallet: 20000 };
  const ctx = { table, session, body: {}, io, send: (id, data) => messages.push({ uid: 1, id, data: structuredClone(data) }) };
  return { game, table, messages, io, session, ctx };
}

test('native casino seat and bet work without an unsupported ordinary carry request', async () => {
  const f = fixture();
  f.game.onJoin(f.ctx);
  f.game.onSitDown({ ...f.ctx, body: { position: 3 } });
  const member = f.table.members.find(m => m.uid === 1);
  assert.ok(member);
  assert.equal(f.session.wallet, 20000, 'reserving a seat never transfers the entire wallet');
  assert.equal(member.point, 0, 'no synthetic carry-in or fabricated table chips');
  assert.ok(!member.carryDeadline, 'native casino has no ordinary carry panel or timeout');
  assert.equal(f.messages.some(m => m.id === 3229), false, 'native casino cannot consume CARRYIN_RESULT');
  assert.equal(f.game.publicMember(member).point, 20000);
  assert.equal(f.game.seated(f.table).length, 1);
  engine.begin(f.io, f.table);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 3, betAmount: 100, pairAmount: 0, notPairAmount: 0 });
  const response = f.messages.findLast(m => m.id === 4556 && m.uid === 1)?.data;
  assert.equal(response?.code, 200);
  assert.equal(response.point, 19900);
  assert.equal(f.session.wallet, 19900, 'only the accepted wager is debited');
  assert.equal(member.point, 0);
  assert.equal(projectSeatMessage(f.table, f.session, 9212, { uid: 1, point: 19900 }), 19900);
  for (let i = 0; i < 80 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline);
  const result = f.table.hand.results.find(p => p.uid === 1);
  assert.equal(f.session.wallet + member.point + f.table.houseNetScore, 20000);
  assert.equal(result.point, f.session.wallet + member.point);
  assert.equal(f.game.shouldStandAfterRound(f.table, member), false, 'unbet wallet remains available');
  engine.tick(f.io, f.table, f.table.hand.deadline);
  f.game.onStandUp(f.ctx);
  assert.equal(f.table.members.length, 0);
  assert.equal(f.session.wallet + f.table.houseNetScore, 20000, 'stand returns escrow once without paying the wallet twice');
});

test('native wallet debits are exact and failed persistence retries across hot reload without another debit', async () => {
  const f = fixture();
  let debits = 0, writes = 0;
  f.io.wallet = {
    debit(session, amount) { debits++; session.wallet -= amount; return { ok: true, balance: session.wallet }; },
    async persist(session) { assert.equal(session.wallet, 19900); if (++writes === 1) throw new Error('retry persistence'); },
  };
  f.game.onSitDown({ ...f.ctx, body: { position: 3 } });
  engine.begin(f.io, f.table);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 2, betAmount: 100 });
  assert.equal(debits, 0);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 3, betAmount: 100 });
  assert.equal(debits, 1);
  await assert.rejects(f.game.afterRound(f.ctx), /retry persistence/);
  assert.equal(f.table.casinoWalletDirty.size, 1);
  await new BlackjackGame().afterRound(f.ctx);
  assert.equal(writes, 2);
  assert.equal(debits, 1);
  assert.equal(f.table.casinoWalletDirty.size, 0);
  assert.equal(f.session.wallet, 19900);
});

test('authoritative casino debit rejection updates available funds without fabricating a wager', () => {
  const f = fixture();
  f.io.wallet = { debit: () => ({ ok: false, balance: 50 }) };
  f.game.onSitDown({ ...f.ctx, body: { position: 3 } });
  engine.begin(f.io, f.table);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 3, betAmount: 100 });
  const response = f.messages.findLast(m => m.id === 4556 && m.uid === 1).data;
  assert.equal(response.code, 'CLUB_USER_POINT_NOT_ENOUGH');
  assert.equal(response.point, 50);
  assert.equal(f.session.wallet, 50);
  assert.equal(f.table.hand.players[0].mainBet, 0);
  assert.equal(f.table.members[0].point, 0);
  assert.equal(f.table.hand.actionList.length, 0);
  assert.ok(!f.table.casinoWalletDirty?.size);
});

test('empty casino accounts cannot occupy a chair while ordinary buy-in rules remain unchanged', () => {
  const f = fixture();
  f.session.wallet = 50;
  f.game.watch(f.table, f.session);
  f.game.onSitDown({ ...f.ctx, body: { position: 3 } });
  assert.equal(f.table.members.length, 0);
  assert.equal(f.table.observers[0].uid, 1);
  assert.equal(f.messages.findLast(m => m.id === 4556).data.code, 'CLUB_USER_POINT_NOT_ENOUGH');
  const ordinary = f.game.createTable(31010000, 31, { play_mode: 0 });
  f.session.wallet = 20000;
  f.game.onSitDown({ ...f.ctx, table: ordinary, body: { position: 0 } });
  assert.equal(ordinary.members[0].point, 0);
  assert.ok(ordinary.members[0].carryDeadline > Date.now());
  assert.equal(ordinary.members[0].casinoWalletSession, undefined);
  assert.equal(f.session.wallet, 20000);
});

test('native casino split, double, insurance and pending departure preserve account plus escrow', async () => {
  for (const insurance of [false, true]) {
    const f = fixture();
    f.game.onSitDown({ ...f.ctx, body: { position: 3 } });
    engine.begin(f.io, f.table, 1000, [...(insurance ? [0, 9, 7, 20] : [9, 6, 7, 20, 2, 3, 4]), ...makeShoe()]);
    assert.ok(engine.act(f.io, f.table, 1, SEND.BET, { targetPos: 3, betAmount: 100 }, 1001));
    engine.tick(f.io, f.table, f.table.hand.deadline);
    engine.tick(f.io, f.table, f.table.hand.deadline);
    if (insurance) {
      assert.equal(f.table.hand.state, STATE.INSURANCE);
      assert.ok(engine.act(f.io, f.table, 1, SEND.INSURANCE, { buyInsurance: true }, f.table.hand.deadline - 1));
      assert.equal(f.session.wallet, 19850);
    } else {
      engine.tick(f.io, f.table, f.table.hand.deadline);
      assert.equal(f.table.hand.state, STATE.PLAYER);
      assert.ok(engine.act(f.io, f.table, 1, SEND.SPLIT, {}, f.table.hand.deadline - 1));
      assert.equal(f.session.wallet, 19800);
      assert.ok(engine.act(f.io, f.table, 1, SEND.DOUBLE, {}, f.table.hand.deadline - 1));
      assert.equal(f.session.wallet, 19700);
    }
    assert.equal(f.game.onLeave(f.ctx), 0);
    for (let i = 0; i < 80 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline);
    assert.equal(f.session.wallet + f.table.members[0].point + f.table.houseNetScore, 20000);
    engine.tick(f.io, f.table, f.table.hand.deadline);
    await f.game.afterRound(f.ctx);
    assert.equal(f.table.members.length, 0);
    assert.equal(f.session.wallet + f.table.houseNetScore, 20000);
    const balance = f.session.wallet;
    await new BlackjackGame().afterRound(f.ctx);
    assert.equal(f.session.wallet, balance);
  }
});
test('casino room creation completes native entry metadata and preserves ordinary room configuration', () => {
  const f = fixture();
  f.game.onJoin(f.ctx);
  assert.equal(f.table.members.length, 0);
  assert.equal(f.table.observers[0].uid, 1);
  const joined = f.messages.find(m => m.id === 2201).data;
  assert.equal(joined.conf.playMode, 1);
  assert.equal(joined.conf.roomType, 'bj21');
  assert.equal(joined.conf.maxPeople, 5);
  assert.deepEqual(f.messages.find(m => m.id === 2206).data.memberList.map(m => m.displaySeat), DISPLAY_SEATS);
  for (const key of ['dealerNo', 'dealerBgNo', 'tableClothNo']) assert.ok(joined.conf.bj21Params[key] > 0);
  const ordinary = f.game.createTable(31010000, 31, { play_mode: 0 });
  assert.equal(f.game.buildConf(ordinary).playMode, 0);
  assert.equal(f.game.buildConf(ordinary).maxPeople, 3);
  assert.equal(ordinary.carryMin, 500);
});
test('casino allocation stays separate by agent/configuration/mode and retains room lifetime', () => {
  const { game, table } = fixture(), registry = createRegistry();
  const pool = createRoomPool({ registry }, () => game);
  const first = pool.allocate(1, table.cfg, 0, 1000);
  const again = pool.allocate(1, table.cfg, 0, 2000);
  assert.equal(again.roomId, first.roomId);
  assert.equal(again.createdAt, 1000);
  assert.equal(again.expiresAt, 1000 + 8 * 3600000);
  assert.equal(first.maxPeople, 5);
  pool.allocate(2, table.cfg, 0, 2000);
  const ordinary = pool.allocate(1, { ...table.cfg, play_mode: 0, game_room_config_id: 3101 }, 0, 2000);
  assert.equal(ordinary.maxPeople, 3);
  assert.equal(ordinary.playMode, 0);
  assert.equal(registry.tables.size, 3);
});
test('casino LOGIN_ROOM resends account balance and upgrades legacy pending seats on reconnect', () => {
  const f = fixture();
  f.game.watch(f.table, f.session);
  f.game.onLoginRoom(f.ctx);
  assert.equal(f.messages.find(m => m.id === 9212)?.data, 20000,
    'JOIN_ROOM balance can arrive before native listeners; LOGIN_ROOM must restore it');
  f.messages.length = 0;
  f.table.members = [{ uid: 1, pos: 0, point: 0, carryDeadline: Date.now() + 12000 }];
  f.table.observers = [];
  f.game.onLoginRoom(f.ctx);
  assert.equal(f.messages.find(m => m.id === 9212)?.data, 20000,'native casino seat still uses the real available account');
  assert.ok(!f.table.members[0].carryDeadline, 'reconnect removes the obsolete ordinary buy-in timeout');
  f.messages.length = 0;
  f.table.members[0].point = 900;
  f.table.members[0].carryDeadline = 0;
  f.game.onLoginRoom(f.ctx);
  assert.equal(f.messages.find(m => m.id === 9212)?.data, 20900,'reconnect includes real escrow left from prior settlements');
});
test('native display seat click uses account funds and robot positions stay internal', () => {
  const f = fixture();
  f.game.watch(f.table, f.session);
  f.ctx.body = { position: 6 };
  f.game.onSitDown(f.ctx);
  const member = f.table.members[0];
  assert.equal(member.pos, 4);
  assert.equal(member.displaySeat, 6);
  assert.equal(member.point, 0);
  assert.ok(!member.carryDeadline);
  assert.equal(f.session.wallet, 20000);
  f.ctx.body = { carryIn: 10 };
  f.game.onCarryScore(f.ctx);
  assert.equal(member.point, 0, 'manual ordinary buy-in is rejected by the casino adapter');
  assert.equal(f.session.wallet, 20000);
  assert.equal(f.game.defaultBuyIn(f.table), 1000);
  assert.equal(f.game.publicMember(member).displaySeat, 6);
  const projected = projectSeatMessage(f.table, f.session, 9212, { uid: 1, point: 19000 });
  assert.equal(projected, 20000);
  assert.equal(projectSeatMessage(f.table, { userId: 99 }, 9212, { uid: 99, point: 456 }), 456);
  assert.deepEqual(restoreSeatRequest(f.table, { userId: 99 }, 5003, { position: 6 }), { position: 6 });
  const botSession = { userId: 2, bot: true, wallet: 2000 };
  f.game.onSitDown({ ...f.ctx, session: botSession, body: { position: 0 } });
  assert.equal(f.table.members[1].pos, 0);
  assert.equal(f.table.members[1].displaySeat, 1);
});
test('casino native bets return 4556 and personalized 4557 without observer controls or NaN', () => {
  const f = fixture();
  f.table.members = [1, 2].map((uid, pos) => ({ uid, pos, displaySeat: DISPLAY_SEATS[pos], point: 5000, name: 'p' + uid }));
  engine.begin(f.io, f.table, 1000, [9, 6, 7, 20, 2, 3, ...makeShoe()]);
  const before = f.table.members.map(m => m.point);
  for (const body of [{ targetPos: 2, betAmount: 100 }, { targetPos: 1, betAmount: 100, pairAmount: 100 },
    { targetPos: 1, betAmount: 100, notPairAmount: 100 }, { targetPos: 1, betAmount: '100' }])
    assert.equal(engine.act(f.io, f.table, 1, SEND.BET, body, 1001), false);
  assert.deepEqual(f.table.members.map(m => m.point), before);
  assert.equal(engine.act(f.io, f.table, 99, SEND.BET, { targetPos: 1, betAmount: 100 }, 1001), false);
  assert.ok(engine.act(f.io, f.table, 1, SEND.BET, { targetPos: 1, betAmount: 100, pairAmount: 0, notPairAmount: 0 }, 1001));
  const response = f.messages.find(m => m.id === 4556 && m.uid === 1).data;
  assert.equal(response.code, 200);
  assert.equal(response.point, 4900);
  assert.equal(response.targetDisplaySeat, 1);
  const mine = f.messages.find(m => m.id === 4557 && m.uid === 1 && m.data.uid === 1).data;
  const observer = f.messages.find(m => m.id === 4557 && m.uid === 99 && m.data.uid === 1).data;
  assert.equal(mine.myAnteBet, 100);
  assert.equal(observer.myAnteBet, 0);
  assert.equal(mine.betAmount + mine.mainBet, 100);
  for (let i = 0; i < 80 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline);
  assert.equal(f.table.hand.state, STATE.SETTLE);
  assert.equal(engine.historyPayload(f.table, { beginNum: -1 }, 1).gameBackInfo.playMode, 1);
  assert.equal(f.table.members.reduce((n, m) => n + m.point, 0) + f.table.houseNetScore, 10000);
  assert.ok(f.messages.filter(m => m.id === 4550 || m.id === 4554).every(m =>
    m.data.players.every(p => DISPLAY_SEATS.includes(p.displaySeat))));
  assert.ok(f.messages.filter(m => m.uid === 99 && [4550, 4554].includes(m.id)).every(m => m.data.selfAvailableActions.length === 0));
  assert.ok(f.messages.filter(m => m.uid === 1 && m.id === 4550).some(m => m.data.selfAvailableActions.includes('STAND')));
});

test('casino rejected observer bet preserves wallet and does not report a false phase error', () => {
  const f = fixture();
  f.game.watch(f.table, f.session);
  f.table.members = [{ uid: 2, pos: 1, point: 5000 }];
  engine.begin(f.io, f.table);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 2, betAmount: 100 });
  const response = f.messages.findLast(m => m.id === 4556 && m.uid === 1)?.data;
  assert.equal(response?.point, 20000, 'a failed bet must not overwrite observer wallet with zero');
  assert.equal(response.code, 'BET_FAILED');
  assert.equal(f.session.wallet, 20000);
  assert.equal(f.table.members[0].point, 5000);
});

test('native casino seat joining during betting can bet and top up the same hand without carry-in', () => {
  const f = fixture();
  f.game.watch(f.table, f.session);
  f.table.members = [{ uid: 2, pos: 1, point: 5000 }];
  engine.begin(f.io, f.table);
  const inning = f.table.currentInning;
  const commitment = f.table.fairCodes.get(inning).notarizationCode;
  const deadline = f.table.hand.deadline;
  f.game.onSitDown({ ...f.ctx, body: { position: 6 } });
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 6, betAmount: 100 });
  let response = f.messages.findLast(m => m.id === 4556 && m.uid === 1)?.data;
  assert.equal(response?.code, 200);
  assert.equal(response.point, 19900);
  f.game.onMessage(f.ctx, SEND.BET, { targetPos: 6, betAmount: 200 });
  response = f.messages.findLast(m => m.id === 4556 && m.uid === 1).data;
  assert.equal(response.code, 200, 'native confirm/repeat accepts incremental own-seat bets');
  assert.equal(response.point, 19700);
  assert.equal(f.table.hand.players.filter(p => p.uid === 1).length, 1);
  const p = f.table.hand.players.find(p => p.uid === 1);
  assert.equal(p.mainBet, 300);
  assert.equal(p.hands[0].betAmount, 300);
  assert.equal(p.member.totalBet, 300);
  assert.equal(f.table.hand.statsPlayers.filter(p => p.uid === 1).length, 1);
  assert.equal(f.table.hand.deadline, deadline);
  assert.equal(f.table.currentInning, inning);
  assert.equal(f.table.fairCodes.get(inning).notarizationCode, commitment);
  for (let i = 0; i < 80 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline);
  assert.equal(f.table.hand.state, STATE.SETTLE);
  assert.equal(f.table.roomFeatures.players.get(1).totalHands, 1);
  assert.equal(f.session.wallet + f.table.members.reduce((sum, m) => sum + m.point, 0) + f.table.houseNetScore, 25000);
});

test('casino bet errors distinguish balance, total limit, unsupported target and actual phase', () => {
  const f = fixture();
  f.table.members = [{ uid: 1, pos: 0, point: 20000 }];
  engine.begin(f.io, f.table);
  const check = (body, code, point) => {
    f.game.onMessage(f.ctx, SEND.BET, body);
    const response = f.messages.findLast(m => m.id === 4556 && m.uid === 1).data;
    assert.equal(response.code, code);
    assert.equal(response.point, point);
  };
  check({ targetPos: 2, betAmount: 100 }, 'BET_FAILED', 20000);
  check({ targetPos: 1, betAmount: '100' }, 'BET_FAILED', 20000);
  check({ targetPos: 1, betAmount: 10100 }, 'BET_OVER_MAX_LIMIT', 20000);
  check({ targetPos: 1, betAmount: 6000 }, 200, 14000);
  check({ targetPos: 1, betAmount: 4100 }, 'BET_OVER_MAX_LIMIT', 14000);
  f.table.members[0].point = 50;
  check({ targetPos: 1, betAmount: 100 }, 'CLUB_USER_POINT_NOT_ENOUGH', 50);
  f.table.hand.deadline = Date.now();
  check({ targetPos: 1, betAmount: 100 }, 'ILLEGAL_OPERATION', 50);
  f.table.hand.deadline = Date.now() + 10000;
  f.table.hand.state = STATE.DEAL;
  check({ targetPos: 1, betAmount: 100 }, 'ILLEGAL_OPERATION', 50);
});

test('casino deadlines do not admit late carries and internal departure timeout still settles normally', () => {
  const f = fixture();
  f.table.members = [{ uid: 1, pos: 0, point: 5000 }];
  engine.begin(f.io, f.table);
  f.game.onLeave(f.ctx);
  assert.equal(f.table.members[0].pendingDeparture, true);
  engine.tick(f.io, f.table, f.table.hand.deadline);
  assert.equal(f.table.hand.state, STATE.DEAL);
  const bet = f.table.hand.players[0].mainBet;
  assert.ok(Number.isSafeInteger(bet) && bet >= f.table.ante && bet <= f.table.roomRules.maxBet);
  assert.equal(f.table.members[0].point, 5000 - bet);
  f.table.members.push({ uid: 2, pos: 1, point: 1000 });
  assert.equal(engine.joinBettingHand(f.io, f.table, 2), false);
  assert.equal(f.table.hand.players.some(p => p.uid === 2), false);
  for (let i = 0; i < 80 && !f.table.hand.settled; i++) engine.tick(f.io, f.table, f.table.hand.deadline);
  assert.equal(f.table.hand.state, STATE.SETTLE);
  assert.equal(f.table.members.reduce((sum, m) => sum + m.point, 0) + f.table.houseNetScore, 6000);
});
