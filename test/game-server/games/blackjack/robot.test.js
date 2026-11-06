import test from 'node:test';
import assert from 'node:assert/strict';
import { choose, actionValues, decisionContext } from '../../../../game-server/src/games/blackjack/robot.js';
import { BlackjackGame } from '../../../../game-server/src/games/blackjack/BlackjackGame.js';
import * as engine from '../../../../game-server/src/games/blackjack/engine.js';
import { SEND, STATE } from '../../../../game-server/src/games/blackjack/messages.js';

test('issued human cards affect hit/stand EV without accessing the hidden dealer card or shoe', () => {
  const actor = { uid: 1, currentHandIndex: 0, hands: [{ cards: [9, 5], splitHand: false }] };
  const human = { uid: 2, hands: [{ cards: [] }] };
  const table = { hand: { dealer: [9, 0], players: [actor, human] } };
  const forbidden = { get() { throw new Error('hidden dealer/shoe accessed'); } };
  Object.defineProperty(table.hand.dealer, 1, forbidden);
  Object.defineProperty(table.hand, 'deck', forbidden);
  Object.defineProperty(table, 'shoe', forbidden);
  const decide = () => choose(actor.hands[0].cards, 9, ['HIT', 'STAND'], decisionContext(table, actor));
  assert.equal(decide(), 'HIT');
  human.hands[0].cards = [1, 2, 3, 4];
  assert.equal(decide(), 'STAND');
  for (const actions of [['STAND'], ['HIT', 'STAND'], ['HIT', 'STAND', 'DOUBLE']]) {
    const choice = choose([4, 5], 8, actions, { exposed: [4, 5, 8], noBlackjack: true });
    assert.ok(actions.includes(choice));
  }
  const values = actionValues([0, 1, 2, 3], 9, ['HIT', 'STAND'], { exposed: [0, 1, 2, 3, 9], noBlackjack: true });
  assert.ok(Number.isFinite(values.HIT) && Number.isFinite(values.STAND));
});

test('mixed blackjack tables complete normal actions and conserve chips against the house', t => {
  let seed = 41;
  t.mock.method(Math, 'random', () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296));
  const game = new BlackjackGame(), io = { env: 'dev', broadcast() {} };
  for (let n = 0; n < 20; n++) {
    const table = game.createTable(850000 + n, 31, { ante: 100, carry_min: 500 });
    table.members = [0, 1, 2].map(pos => ({ uid: pos + 1, pos, point: 10000, bot: pos > 0 }));
    engine.begin(io, table, 1000);
    assert.ok(engine.act(io, table, 1, SEND.BET, { betAmount: 100 }, 1001));
    let now = 1000, turns = 0;
    while (table.hand && !table.hand.settled && turns++ < 600) {
      const h = table.hand;
      if (h.state === STATE.INSURANCE && !h.players[0].insuranceOperated) engine.act(io, table, 1, SEND.INSURANCE, { buyInsurance: false }, now);
      if (h.state === STATE.PLAYER) engine.act(io, table, 1, SEND.STAND, {}, now);
      now += 500; engine.tick(io, table, now);
    }
    assert.ok(table.hand.settled);
    assert.equal(table.members.reduce((sum, p) => sum + p.point, 0) + table.houseNetScore, 30000);
    assert.ok(table.members.every(p => p.point >= 0 && Number.isSafeInteger(p.point)));
  }
});
