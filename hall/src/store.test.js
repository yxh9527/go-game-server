import assert from "node:assert/strict";
import test from "node:test";
import { createMatchStore } from "./store.js";

test("apply match envelope updates memory only", () => {
  const store = createMatchStore();
  store.replaceMatches([{ id: 2, state: 1, championship_name: "old" }]);
  store.applyEnvelope(JSON.stringify({
    event: "match_state",
    data: JSON.stringify({ id: 2, state: 2, championship_name: "new" }),
  }));
  assert.equal(store.getMatch(2).state, 2);
  assert.equal(store.getMatch(2).championship_name, "new");
});
