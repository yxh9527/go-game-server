import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { ZjhGame } from '../../../../game-server/src/games/zjh/ZjhGame.js';
import { ranking } from '../../../../game-server/src/core/room-features.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';

const row = () => seedRooms().find(r => r.game_room_config_id === 134);

test('look-two information renders the reference values through the original client', () => {
  const game = new ZjhGame(), table = game.createTable(1340000, 25, row());
  const info = game.roomInfo(table), conf = game.buildConf(table);
  assert.equal(conf.maxPeople, 7);
  assert.equal(info.memberList.length, 7);
  assert.equal(info.disusePoint, 900);
  assert.equal(info.ctjh.taxType, 2);
  assert.equal(info.ctjh.taxPercent, 500);
  assert.equal(ranking(table).taxPercent, 500);
  const source = fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/Zjh/index.df153.js', import.meta.url), 'utf8');
  const anchor = "ay['prototype']['getTableInfo']=";
  const start = source.indexOf(anchor) + anchor.length;
  const end = source.indexOf(",ay['prototype']", start);
  assert.ok(start >= anchor.length && end > start);
  const render = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    console: { error() {} }, cc: { app: { gameRoom: { isMttRoom: false } } },
    a5: { default: { getLangText: (_group, key) => key, transformLmCoinTrue: n => n / 100 } },
    X: { default: { keepDecimal: n => n } },
    ag: { startParameterData: { gameRule: ['rank', 'suit'], bipaiCircle: ['unlimited'],
      bipaiMultiple: ['single', 'double'], menbiLimit: ['forbidden', 'allowed'] } },
  });
  const values = new Map(render.call({ statusColr: { white: 'white', gray: 'gray' } }, info).map(v => [v.key, v.value]));
  for (const [key, value] of Object.entries({ base_score: '1', zjh_mrdyjfp_: '10', elimination_score: '9',
    duration: '8h', seat_count: '7', zjh_bpgz_: 'suit', zjh_zdqs_: '8', zjh_bmqs_: '1',
    zjh_bpqs_: 'unlimited', zjh_bpbs_: 'double', zjh_mjxz_: 'forbidden', zjh_dzfd_: 'zjh_bfd',
    time_bank: '11s', activity_score: '5.0%', zjh_jfpmrsx_: 'no_limit',
    zjh_pgzjy_: '<color=white>kaiqi</c>', zjh_sjrz_: '<color=white>kaiqi</c>',
    zjh_jzmnq_: '<color=gray>guanbi</c>' })) assert.equal(values.get(key), value, key);
});

test('seven actual seats are available and random seating still requires explicit buy-in', t => {
  const game = new ZjhGame(), table = game.createTable(1340000, 25, row());
  t.mock.method(Math, 'random', () => 0.999);
  const sessions = Array.from({ length: 8 }, (_, i) => ({ userId: i + 1, wallet: 10000 }));
  for (const session of sessions) game.watch(table, session);
  assert.equal(table.members.length, 0, 'entering remains observer-only');
  for (const session of sessions.slice(0, 7)) {
    const member = game.sit(table, session, {}, { pos: 0, buyIn: 0 });
    assert.equal(member.pos, 7 - session.userId);
    assert.equal(member.point, 0);
    assert.ok(member.carryDeadline > Date.now());
    assert.equal(session.wallet, 10000);
  }
  assert.equal(game.sit(table, sessions[7], {}, { buyIn: 0 }), null);
  assert.equal(table.members.length, 7);
});

test('post-hand elimination uses the displayed inclusive threshold and refunds once', async () => {
  const game = new ZjhGame(), table = game.createTable(1340000, 25, row());
  table.roomFeatures.settledInning = 1;
  const sessions = new Map([1, 2, 3].map(userId => [userId, { userId, wallet: 0 }]));
  table.members = [900, 901, 1000].map((point, i) => ({ uid: i + 1, point, pos: i }));
  let credits = 0;
  const ctx = { table, io: { broadcast() {}, sessionFor: uid => sessions.get(uid) },
    wallet: { credit(session, amount) { credits++; session.wallet += amount; return { ok: true }; }, async persist() {} } };
  await game.afterRound(ctx);
  await game.afterRound(ctx);
  assert.deepEqual(table.members.map(m => m.point), [901, 1000]);
  assert.equal(sessions.get(1).wallet, 900);
  assert.equal(credits, 1);
  assert.equal(table.observers[0].uid, 1);
});

test('room policy overrides stay consistent across seats, ranking and information', () => {
  const game = new ZjhGame();
  const cfg = { ...row(), payload: JSON.stringify({ ctjhParams: {
    maxPeople: 4, disusePoint: 800, randomSit: false, banTalk: false, taxType: 2, taxPercent: 250,
  } }) };
  const table = game.createTable(1340000, 25, cfg);
  const info = game.roomInfo(table);
  assert.equal(game.maxPeople(table), 4);
  assert.equal(info.memberList.length, 4);
  assert.equal(game.buildConf(table).maxPeople, 4);
  assert.equal(info.disusePoint, 800);
  assert.equal(info.ctjh.randomSit, false);
  assert.equal(info.ctjh.banTalk, false);
  assert.equal(ranking(table).taxPercent, 250);
  assert.equal(game.sit(table, { userId: 1 }, {}, { pos: 2, buyIn: 0 }).pos, 2);
});
