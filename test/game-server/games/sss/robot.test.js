import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, decisionContext } from '../../../../game-server/src/games/sss/robot.js';
import { arrange, evaluate, validArrangement } from '../../../../game-server/src/games/sss/hand.js';
import { SssGame } from '../../../../game-server/src/games/sss/SssGame.js';
import * as engine from '../../../../game-server/src/games/sss/engine.js';

test('opponent-aware arrangement improves actual pile scores rather than always taking the first recommendation', () => {
  const hole = [18, 41, 42, 3, 51, 30, 37, 4, 50, 29, 21, 13, 6];
  const other = [8, 16, 47, 28, 7, 0, 22, 20, 26, 32, 31, 44, 45];
  const options = arrange(hole, 12), plans = arrange(other, 3);
  const actor = { uid: 1, bot: true, hole, options, openingPoint: 10000 };
  const human = { uid: 2, hole: other, options: plans, openingPoint: 10000 };
  const bot = { uid: 3, bot: true };
  Object.defineProperty(bot, 'hole', { get() { throw new Error('bot cards read'); } });
  Object.defineProperty(bot, 'options', { get() { throw new Error('bot arrangement read'); } });
  const table = { ante: 10, hand: { players: [actor, human, bot] } };
  Object.defineProperty(table.hand, 'deck', { get() { throw new Error('future deck read'); } });
  const selected = choose(options, () => 0, decisionContext(table, actor));
  assert.ok(validArrangement(hole, selected.front, selected.middle, selected.back));
  assert.equal(evaluate(selected.front, selected.middle, selected.back).isWater, false);
  const score = option => engine.comparison({ ante: 10, hand: { players: [
    { uid: 1, openingPoint: 10000, result: evaluate(option.front, option.middle, option.back) },
    { uid: 2, openingPoint: 10000, result: evaluate(plans[0].front, plans[0].middle, plans[0].back) },
  ] } }).scoreMap[1];
  assert.ok(score(selected) > score(options[0]));
});

test('four/eight-joker mixed tables retain physical cards, legal piles and conserved settlement', t => {
  let seed = 53;
  t.mock.method(Math, 'random', () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
  const game = new SssGame(), io = { env: 'dev', broadcast() {}, forEachPlayer() {} };
  for (const mode of [0, 1]) for (let index = 0; index < 4; index++) {
    const table = game.createTable(860000 + mode * 10 + index, 27, { ante: 10, carry_min: 1000, play_mode: mode });
    table.members = Array.from({ length: 2 + index % 3 }, (_, pos) => ({ uid: pos + 1, pos, point: 10000, bot: pos > 0 }));
    engine.begin(io, table, 1000);
    const h = table.hand, original = h.players.map(p => p.hole.slice());
    const human = h.players[0];
    assert.ok(engine.arrange(io, table, human.uid, human.options[0]));
    let now = 1000, turns = 0;
    while (table.hand && !h.settled && turns++ < 100) { now += 1000; engine.tick(io, table, now); }
    assert.ok(h.settled);
    for (const [i, p] of h.players.entries()) {
      assert.deepEqual(p.hole, original[i]);
      assert.ok(validArrangement(p.hole, p.front, p.middle, p.back));
      assert.equal(p.result.isWater, false);
    }
    assert.equal(table.members.reduce((n, p) => n + p.point, 0), table.members.length * 10000);
  }
});
