import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseMultiple, decisionContext } from '../../../../game-server/src/games/sgay/robot.js';
import { SgayGame } from '../../../../game-server/src/games/sgay/SgayGame.js';
import * as engine from '../../../../game-server/src/games/sgay/engine.js';

test('ranked-pot expected return changes exposure against strong and weak human hands', () => {
  const actor = { uid: 1, pos: 0, bot: true, openingPoint: 1000, bet: null };
  const human = { uid: 2, pos: 1, openingPoint: 1000, bet: 100, hole: [2, 15, 28] };
  const hand = { rules: { taxPercent: 0, maxTax: 0 }, players: [actor, human] };
  Object.defineProperty(hand, 'deck', { get() { throw new Error('future deck read'); } });
  Object.defineProperty(actor, 'hole', { get() { throw new Error('third card read'); } });
  const cards = [10, 24, 0];
  Object.defineProperty(cards, 2, { get() { throw new Error('third card slot read'); } });
  const decide = () => chooseMultiple({ cards, maxMultiple: 10, point: 1000, ante: 10, context: decisionContext({ hand }, actor) });
  assert.equal(decide(), 1);
  human.hole = [0, 4, 8];
  assert.ok(decide() > 1);
});

test('mixed Sgay tables choose legal multiples and settle with conserved chips', () => {
  const game = new SgayGame(), messages = [];
  const io = { env: 'dev', forEachPlayer() {}, broadcast(id, data) { messages.push({ id, data }); } };
  for (let index = 0; index < 20; index++) {
    const table = game.createTable(840000 + index, 32, { ante: 10, carry_min: 1000, tax_percent: 0 });
    table.members = Array.from({ length: 2 + index % 6 }, (_, pos) => ({ uid: pos + 1, pos, point: 1000, bot: pos > 0 }));
    const initial = table.members.reduce((n, p) => n + p.point, 0);
    engine.begin(io, table, 1000);
    let now = 1000, turns = 0;
    while (table.hand && turns++ < 50) {
      const h = table.hand, human = h.players[0];
      if (h.stage === 'bet' && human.bet === null) engine.bet(io, table, human.uid, 2, now);
      if (h.stage === 'show' && !human.shown) engine.show(io, table, human.uid, {}, now);
      now += 500; engine.tick(io, table, now);
    }
    assert.equal(table.hand, null);
    assert.equal(table.members.reduce((n, p) => n + p.point, 0), initial);
    assert.ok(table.members.every(p => p.point >= 0 && Number.isSafeInteger(p.point)));
  }
});
