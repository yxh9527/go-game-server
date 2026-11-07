import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, decisionContext } from '../../../../game-server/src/games/niuniu/robot.js';
import { roomRules } from '../../../../game-server/src/games/niuniu/config.js';
import { NiuniuGame } from '../../../../game-server/src/games/niuniu/NiuniuGame.js';
import * as engine from '../../../../game-server/src/games/niuniu/engine.js';

test('banker strength changes both grab and bet decisions with the same visible cards', () => {
  const actor = { uid: 1, bot: true, openingPoint: 10000 }, human = { uid: 2, hole: [0, 13, 26, 39, 4] };
  const hand = { rules: roomRules({}), laiZi: -1, bankerUid: 2, bankerMultiple: 1, players: [actor, human] };
  Object.defineProperty(hand, 'deck', { get() { throw new Error('future deck read'); } });
  Object.defineProperty(actor, 'hole', { get() { throw new Error('unseen fifth card read'); } });
  const input = { cards: [9, 10, 11, 12], grabMax: 4, multiples: [5, 10, 20, 25] };
  const decide = phase => choose({ ...input, phase, context: decisionContext({ ante: 10, hand }, actor) }, () => 0.5);
  assert.equal(decide('grab'), 0);
  assert.equal(decide('bet'), 5);
  human.hole = [0, 2, 5, 20, 32];
  assert.ok(decide('grab') > 0);
  assert.ok(decide('bet') > 5);
  assert.equal(choose({ ...input, phase: 'grab', auto: { grab: 2 } }), 2);
});

test('all ordinary, blind and wild robot tables settle without exceeding legal multiples or bankrolls', t => {
  let seed = 17;
  t.mock.method(Math, 'random', () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
  const game = new NiuniuGame(), io = { env: 'dev', broadcast() {}, forEachPlayer() {} };
  for (const [mode, see] of [[3, 3], [3, 4], [0, 0], [7, 4]]) for (let n = 0; n < 6; n++) {
    const table = game.createTable(830000 + mode * 10 + n, 24, { ante: 10, carry_min: 1000, play_mode: mode, see_card_no: see });
    table.members = [0, 1, 2].map(pos => ({ uid: pos + 1, pos, point: 10000, bot: pos > 0 }));
    engine.begin(io, table, 1000);
    const h = table.hand;
    let now = 1000, turns = 0;
    while (table.hand && turns++ < 60) {
      const human = h.players[0];
      if (h.stage === 'grab' && human.grab === null) assert.ok(engine.grab(io, table, human.uid, 1, now));
      if (h.stage === 'bet' && human.bet === null && human.uid !== h.bankerUid) assert.ok(engine.bet(io, table, human.uid, engine.betOptions(table, human)[0], now));
      if (h.stage === 'show' && !human.shown) engine.show(io, table, human.uid);
      now += 1000; engine.tick(io, table, now);
      for (const p of h.players) {
        if (p.grab !== null) assert.ok(p.grab >= 0 && p.grab <= engine.grabMax(table, p));
        if (p.bet !== null) assert.ok(table.roomRules.bettingMultiples.includes(p.bet));
      }
    }
    assert.equal(table.hand, null);
    assert.equal(table.members.reduce((sum, p) => sum + p.point, 0), 30000);
    assert.ok(table.members.every(p => p.point >= 0));
  }
});
