import assert from "node:assert/strict";
import test from "node:test";
import { baccaratTotal } from "./rules.js";

test("baccarat totals", () => {
  assert.equal(baccaratTotal([0, 8]), 0);
  assert.equal(baccaratTotal([5, 6]), 3);
});
