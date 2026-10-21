import assert from "node:assert/strict";
import test from "node:test";
import { newEnvelope } from "./envelope.js";

test("envelope data is a json string", () => {
  const raw = newEnvelope("match_state", { id: 1, state: 1 });
  const env = JSON.parse(raw);
  assert.equal(env.event, "match_state");
  assert.equal(typeof env.data, "string");
  assert.equal(JSON.parse(env.data).id, 1);
});
