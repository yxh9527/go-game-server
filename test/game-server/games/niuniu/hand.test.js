import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareHands } from '../../../../game-server/src/games/niuniu/hand.js';
import { roomRules } from '../../../../game-server/src/games/niuniu/config.js';
const cards = ranks => ranks.map((rank, i) => (i % 4) * 13 + rank - 1);
const normal = roomRules({ play_mode: 3 });
const blind = roomRules({ play_mode: 0 });
const wild = roomRules({ play_mode: 7 });

test('ordinary and all-blind use their own type ordering and multipliers', () => {
  const cases = [
    [[0,1,2,3,4],18,8], [[0,13,1,14,2],17,8], [[1,14,27,40,3],16,6],
    [[1,14,27,2,15],15,6], [[0,2,5,8,12],14,5],
    [[10,24,38,49,50],13,5], [cards([3,4,5,6,7]),12,5],
    [cards([10,11,12,13,11]),11,4], [cards([2,8,11,12,13]),10,4],
  ];
  for (const [hand,type,multiple] of cases) {
    const result = evaluate(hand, normal);
    assert.equal(result.niuJi,type,JSON.stringify(hand)); assert.equal(result.belv,multiple);
  }
  assert.equal(evaluate(cards([2,8,11,12,13]), { ...normal, doubleRule: 2 }).belv,3);
  assert.equal(evaluate([1,14,27,40,3],blind).niuJi,16);
  assert.equal(evaluate([1,14,27,40,3],blind).belv,4);
  assert.equal(evaluate([0,13,1,14,2],blind).belv,4);
  assert.notEqual(evaluate([0,1,2,3,4],blind).niuJi,18);
});

test('seven-wild identifies the 21 special ranks and uses the online 35x maximum', () => {
  const cases = [
    [[52,53,54,0,13],31,35], [[52,53,54,1,15],30,30],
    [[12,25,38,51,52],29,29], [[9,10,11,12,0],28,28], [[13,14,15,16,17],27,27],
    [[54,53,9,15,32],26,26], [[54,52,9,15,32],25,25], [[53,52,9,15,32],24,24],
    [[3,4,5,6,7],23,23], [cards([10,11,12,13,1]),22,22], [cards([1,2,3,4,5]),21,21],
    [[0,13,1,14,2],20,20], [[1,14,27,40,3],19,19], [[1,14,27,2,15],18,18],
    [[10,24,38,49,50],17,17], [[0,2,5,8,12],16,16], [cards([3,4,5,6,7]),15,15],
    [cards([10,11,12,13,11]),14,15], [[54,1,16,32,47],13,13],
    [[53,1,16,32,47],12,12], [[52,1,16,32,47],11,11],
  ];
  // Use a wildcard rank absent from fixtures; the three joker-only fixtures
  // disable stronger combination ranks to isolate the face-card types.
  for (const [hand,type,multiple] of cases) {
    const rules = type <= 13 ? { ...wild, specialQiLaiCode: [11,12,13] } : wild;
    const result = evaluate(hand, rules, 7);
    assert.equal(result.niuJi,type,JSON.stringify(hand)); assert.equal(result.belv,multiple);
    assert.equal(result.handCardListWithLaiZi.length,5);
  }
});

test('wildcards form the maximum hand without duplicating or leaking original cards', () => {
  const result = evaluate([1,14,27,40,52], wild, 1);
  assert.equal(result.niuJi,29);
  assert.equal(new Set(result.cardList).size,5);
  assert.ok(result.handCardListWithLaiZi.every(c => c >= 55 && c <= 67));
  const low = evaluate(cards([2,8,11,12,13]), normal);
  const high = evaluate([40,7,23,37,12], normal);
  assert.ok(Number.isFinite(compareHands(low,high)));
  assert.throws(() => evaluate([0,0,1,2,3], normal));
});
