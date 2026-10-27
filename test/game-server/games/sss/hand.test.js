import test from 'node:test';
import assert from 'node:assert/strict';
import { deckFor, evaluatePile, evaluate, compareKey, validArrangement, arrange, special } from '../../../../game-server/src/games/sss/hand.js';

test('four/eight ghost decks omit every two and preserve repeated ghost identities', () => {
  for (const mode of [0, 1]) {
    const deck = deckFor(mode);
    assert.equal(deck.length, mode ? 56 : 52);
    assert.equal(deck.filter(c => c >= 52).length, mode ? 8 : 4);
    assert.ok(deck.every(c => c >= 52 || c % 13 !== 1));
    assert.equal(new Set(deck.filter(c => c < 52)).size, 48);
  }
});
test('ordinary/wildcard types, five of a kind and two ghost front retain raw cards', () => {
  const cards = [0, 13, 26, 52, 53];
  const v = evaluatePile(cards);
  assert.equal(v.typeId, 9); assert.deepEqual(v.cards, cards);
  assert.equal(v.resolved.length, 5); assert.ok(v.resolved.every(c => c % 13 === 0));
  assert.equal(evaluatePile([5, 52, 52], 0).typeId, 120);
  assert.equal(evaluatePile([0, 13, 26], 0).water, 3);
  assert.equal(evaluatePile([0, 13, 26, 39, 5], 1).water, 8);
  assert.equal(evaluatePile([0, 13, 26, 39, 5], 2).water, 4);
});
test('royal > wheel > king high; natural cards win a tie with ghost cards', () => {
  const royal = evaluatePile([0, 9, 10, 11, 12]);
  const wheel = evaluatePile([0, 1, 2, 3, 4]);
  const king = evaluatePile([8, 9, 10, 11, 12]);
  assert.equal(compareKey(royal.key, wheel.key), 1);
  assert.equal(compareKey(wheel.key, king.key), 1);
  assert.equal(compareKey(royal.key, evaluatePile([52, 9, 10, 11, 12]).key), 1);
});
test('arrangement validates card multisets rather than deduplicating ghosts', () => {
  const hole = [52, 52, 53, 0, 13, 26, 39, 2, 3, 4, 5, 6, 7];
  assert.ok(validArrangement(hole, hole.slice(0, 3), hole.slice(3, 8), hole.slice(8)));
  assert.ok(!validArrangement(hole, [52, 53, 53], hole.slice(3, 8), hole.slice(8)));
  assert.ok(!validArrangement(hole, [], hole.slice(3, 8), hole.slice(8)));
  assert.ok(!validArrangement(hole, ['52', 52, 53], hole.slice(3, 8), hole.slice(8)));
});
test('recommendations use all thirteen cards once and avoid fouls, including duplicate ghosts', () => {
  const hands = [
    [52, 52, 53, 0, 13, 26, 39, 2, 3, 4, 5, 6, 7],
    [53, 53, 52, 52, 2, 3, 4, 15, 16, 17, 30, 31, 32],
    [0, 13, 26, 3, 16, 29, 4, 17, 30, 8, 21, 34, 12],
  ];
  for (const hole of hands) {
    const options = arrange(hole);
    assert.ok(options.length);
    for (const o of options) {
      assert.ok(validArrangement(hole, o.front, o.middle, o.back));
      assert.equal(evaluate(o.front, o.middle, o.back).isWater, false);
      assert.ok(o.frontResolved.every(c => c >= 0 && c < 52));
    }
  }
});
test('specials follow original image scores and prohibit ghost substitutions', () => {
  const fourTrips = [0,13,26,3,16,29,4,17,30,8,21,34,12];
  assert.equal(special(fourTrips.slice(0,3),fourTrips.slice(3,8),fourTrips.slice(8)).typeId, 8);
  assert.equal(special([52,13,26],fourTrips.slice(3,8),fourTrips.slice(8)), null);
  assert.equal(special([2,3,4],[18,19,20,21,22],[32,33,34,35,36]).typeId, 3);
  assert.equal(special([2,3,4],[18,19,20,21,22],[32,33,34,35,36]).water, 20);
});
