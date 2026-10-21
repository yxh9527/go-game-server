import assert from "node:assert/strict";
import test from "node:test";
import { compare3, evaluate3 } from "./hand.js";

test("baozi beats straight flush", () => {
  const baozi = evaluate3([0, 13, 26]);
  const sf = evaluate3([0, 1, 2]);
  assert.equal(baozi.cardTypeId, 6);
  assert.ok(compare3(baozi, sf) > 0);
});

test("pair beats high card", () => {
  const pair = evaluate3([0, 13, 2]);
  const high = evaluate3([12, 23, 34]);
  assert.equal(pair.cardTypeId, 2);
  assert.ok(compare3(pair, high) > 0);
});
