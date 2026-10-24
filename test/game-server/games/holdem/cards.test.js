import assert from "node:assert/strict";
import test from "node:test";
import { cardName, compareRank, evaluate7 } from "../../../../game-server/src/games/holdem/cards.js";

test("card names match protocol sample", () => {
  assert.equal(cardName(41), "SPADE_3");
  assert.equal(cardName(28), "HEART_3");
  assert.equal(cardName(12), "DIAMOND_K");
  assert.equal(cardName(26), "HEART_A");
  assert.equal(cardName(39), "SPADE_A");
});

test("two pair aces and threes is cardTypeId 3", () => {
  const rank = evaluate7([41, 28, 12, 26, 39]);
  assert.equal(rank.cardTypeId, 3);
  assert.equal(rank.name, "TWO_PAIR");
});

test("royal flush beats four of a kind", () => {
  const royal = evaluate7([0, 9, 10, 11, 12]);
  const quads = evaluate7([0, 13, 26, 39, 1]);
  assert.equal(royal.cardTypeId, 10);
  assert.ok(compareRank(royal, quads) > 0);
});


