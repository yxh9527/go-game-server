import assert from "node:assert/strict";
import test from "node:test";
import { validateAwardJSON } from "./award.js";

test("money reward requires currency", () => {
  assert.throws(() => validateAwardJSON(JSON.stringify([
    { rank: 1, items: [{ kind: "money", amount: "10000" }] },
  ])));
  assert.doesNotThrow(() => validateAwardJSON(JSON.stringify([
    { rank: 1, items: [{ kind: "money", currency: "CNY", amount: "10000" }] },
  ])));
});
