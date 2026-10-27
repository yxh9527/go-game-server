import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BlackjackGame } from '../../../../game-server/src/games/blackjack/BlackjackGame.js';
import * as engine from '../../../../game-server/src/games/blackjack/engine.js';
import { makeShoe } from '../../../../game-server/src/games/blackjack/hand.js';
import { SEND } from '../../../../game-server/src/games/blackjack/messages.js';

function settled(mode = 1) {
  const game = new BlackjackGame(), table = game.createTable(31100000, 31, { play_mode: mode, ante: 100 });
  table.members = Array.from({ length: mode ? 5 : 3 }, (_, pos) => ({
    uid: pos + 1, pos, name: 'player-' + pos, icon: '1', point: 5000, state: 2, bot: false,
  }));
  table.observers = [{ uid: 99, name: 'observer' }];
  const io = { env: 'dev', broadcast() {} };
  engine.begin(io, table, 1000, makeShoe());
  for (const p of table.hand.players) assert.ok(engine.act(io, table, p.uid, SEND.BET, { betAmount: 100 }, 1001));
  for (let i = 0; i < 100 && !table.hand.settled; i++) engine.tick(io, table, table.hand.deadline);
  assert.ok(table.hand.settled);
  return { table, io };
}

// Exercise the shipped renderer itself. A string setter matches cc.Label's
// conversion, so an omitted field reproduces the literal 'undefined' bug.
function nativeItem() {
  const source = fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/main/index.88f4e.js', import.meta.url), 'utf8')
    .replace(/\['([A-Za-z_$][\w$]*)'\]/g, '.$1').replace(/,([a-zA-Z]\w*\.prototype\.)/g, ';\n$1');
  const section = source.slice(source.indexOf("'LiveBjkHistoryItem':[function"));
  const line = section.split('\n').find(l => l.startsWith('H.prototype.updateObject='));
  const update = vm.runInNewContext('(' + line.slice(line.indexOf('=') + 1).replace(/;$/, '') + ')', {
    x: { default: { limitLabelCharacters(label, value) { label.string = value; }, colorFromHex: x => x } },
    y: { default: { keepDecimal: x => x } },
    z: { default: { loadSpriteFrame() {}, transformLmCoinTrue: x => String(x / 100), formatText: (...x) => x.join(':') } },
    A: { default: { userData: { uid: 99 } } },
  });
  const label = () => ({ node: { parent: {} }, get string() { return this.value; }, set string(v) { this.value = String(v); } });
  const item = { areaLb: label(), mName: label(), mWinLose: label(), node_banker: {}, sp_head: {}, node_insurance: {},
    main: { updateObject() {} }, split: { node: {}, updateObject() {} },
    SetWinLose(v) { this.mWinLose.string = v; }, setSectionActiveByLabel() {}, setBetAndProfit() {} };
  return row => { update.call(item, row); return item; };
}

test('casino replay renders all five original area numbers from settled seats, without undefined', () => {
  const { table } = settled(), render = nativeItem();
  const payload = engine.historyPayload(table, {}, 99);
  const rows = payload.gameBackInfo.inningInfo[0].filter(p => !p.banker);
  assert.deepEqual(rows.map(p => p.pos), [0, 1, 2, 3, 4]);
  assert.deepEqual(rows.map(p => p.displaySeat), [1, 2, 3, 5, 6]);
  for (const row of rows) {
    const item = render(row);
    assert.equal(item.areaLb.string, String(row.displaySeat));
    assert.ok(!/undefined|NaN/.test(item.areaLb.string + item.mName.string + item.mWinLose.string));
    assert.ok(row.handResults.every(h => h.handCards.length >= 2 && Number.isFinite(h.xiaZhuData)));
  }
  engine.tick({ broadcast() {} }, table, table.hand.deadline);
  table.members.reverse().forEach((m, pos) => { m.pos = pos; m.name = 'changed'; });
  rows[0].displaySeat = 88; rows[0].handResults[0].handCards.length = 0;
  const saved = engine.historyPayload(table, {}, 99).gameBackInfo.inningInfo[0].filter(p => !p.banker);
  assert.deepEqual(saved.map(p => p.displaySeat), [1, 2, 3, 5, 6]);
  assert.equal(saved[0].name, 'player-0');
  assert.ok(saved[0].handResults[0].handCards.length >= 2);
});

test('hot reload restores legacy area only from the same hand; unrecoverable old seats stay explicitly unknown', () => {
  const { table, io } = settled();
  const legacy = table.history[0].players.filter(p => !p.banker);
  for (const p of legacy) { delete p.pos; delete p.displaySeat; }
  assert.deepEqual(engine.historyPayload(table, {}, 99).gameBackInfo.inningInfo[0].filter(p => !p.banker).map(p => p.displaySeat), [1, 2, 3, 5, 6]);
  engine.tick(io, table, table.hand.deadline); table.currentInning++;
  const payload = engine.historyPayload(table, {}, 99);
  assert.ok(payload.gameBackInfo.inningInfo[0].filter(p => !p.banker).every(p => p.displaySeat === '未记录' && p.seatUnavailable));
  assert.ok(legacy.every(p => p.displaySeat === undefined), 'query never mutates stored history');
  assert.equal(nativeItem()(payload.gameBackInfo.inningInfo[0][1]).areaLb.string, '未记录');
});

test('ordinary blackjack replay retains its own coordinates, permissions and paging', () => {
  const { table } = settled(0);
  const payload = engine.historyPayload(table, { beginNum: 0 }, 99);
  assert.equal(payload.currentInning, 1); assert.equal(payload.total, 1);
  assert.deepEqual(payload.gameBackInfo.inningInfo[0].filter(p => !p.banker).map(p => p.pos), [0, 1, 2]);
  assert.equal(payload.gameBackInfo.bankerSettles, undefined);
  assert.equal(engine.historyPayload(table, {}, 100).total, 0);
  assert.equal(engine.historyPayload(table, { gameRoomId: 1 }, 99).total, 0);
  assert.deepEqual(engine.historyPayload(table, { beginNum: 1 }, 99).gameBackInfo.inningInfo, [[]]);
});
