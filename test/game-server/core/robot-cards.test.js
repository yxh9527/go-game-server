import test from 'node:test';
import assert from 'node:assert/strict';
import { humanCards, sampleDeals } from '../../../game-server/src/core/robot-cards.js';

test('human projection excludes bot cards and unknown deals exclude every known card', () => {
  const bot = { uid: 3, bot: true };
  Object.defineProperty(bot, 'hole', { get() { throw new Error('bot secret read'); } });
  const opponents = humanCards([{ uid: 1 }, { uid: 2, hole: [13, 14, 15] }, bot], 1);
  const hand = {};
  Object.defineProperty(hand, 'deck', { get() { throw new Error('future deck read'); } });
  const input = { hand, uid: 1, visible: [0, 1], size: 3, opponents };
  const deals = sampleDeals(input);
  assert.equal(deals.length, 48);
  for (const deal of deals) {
    assert.deepEqual(deal.rivals[0], [13, 14, 15]);
    const cards = [...deal.own, ...deal.rivals.flat()];
    assert.equal(new Set(cards).size, cards.length);
  }
  assert.equal(sampleDeals(input), deals);
  opponents[0].cards = [26, 27, 28];
  assert.notEqual(sampleDeals(input), deals);
  const updated = sampleDeals(input);
  input.visible = [0, 1, 2];
  assert.notEqual(sampleDeals(input), updated);
});
