import {importHotModule} from "../../../../shared/hot-import.js";
import assert from 'node:assert/strict';
import test from 'node:test';
const { awardPots }=await importHotModule(new URL("../../../../game-server/src/games/holdem/pots.js",import.meta.url).href,"pricing-selected-test/game-server/games/holdem/pots.test.js");

function settle(rows, bankerId = 1) {
  const players = rows.map(([uid, totalBet, rank, folded = false], pos) => ({ uid, totalBet, rank, folded, pos }));
  const ranked = players.filter((p) => !p.folded).map((member) => ({ member, eval: member.rank })).sort((a, b) => b.eval - a.eval);
  const result = awardPots(players, ranked, bankerId, (a, b) => a - b);
  assert.equal([...result.payout.values()].reduce((s, v) => s + v, 0), players.reduce((s, p) => s + p.totalBet, 0));
  return result;
}

test('odd chip goes clockwise after dealer; folded contributions remain in the pot', () => {
  const result = settle([[1, 5, 1], [2, 5, 1], [3, 5, 10, true]]);
  assert.deepEqual([...result.payout], [[1, 7], [2, 8], [3, 0]]);
});

test('uncalled excess returns to contributor without becoming a win', () => {
  const result = settle([[1, 100, 1], [2, 200, 2], [3, 500, 0]]);
  assert.deepEqual([...result.payout], [[1, 0], [2, 500], [3, 300]]);
  assert.deepEqual([...result.winners], [2]);
});

test('departed folded player never gets credited again at settlement', () => {
  const result = settle([[1, 50, 2], [2, 100, 1, true], [3, 100, 0, true]]);
  assert.deepEqual([...result.payout], [[1, 250], [2, 0], [3, 0]]);
});
