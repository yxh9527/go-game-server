import assert from "node:assert/strict";
import test from "node:test";
import {
  MATCH_STATE_CANCELLED,
  MATCH_STATE_DRAFT,
  MATCH_STATE_FINISHED,
  MATCH_STATE_REGISTERING,
  MATCH_STATE_RUNNING,
  canTransitMatch,
} from "../../match/src/constants.js";

test("match state machine", () => {
  assert.equal(canTransitMatch(MATCH_STATE_DRAFT, MATCH_STATE_REGISTERING), true);
  assert.equal(canTransitMatch(MATCH_STATE_DRAFT, MATCH_STATE_CANCELLED), true);
  assert.equal(canTransitMatch(MATCH_STATE_REGISTERING, MATCH_STATE_RUNNING), true);
  assert.equal(canTransitMatch(MATCH_STATE_RUNNING, MATCH_STATE_FINISHED), true);
  assert.equal(canTransitMatch(MATCH_STATE_DRAFT, MATCH_STATE_RUNNING), false);
  assert.equal(canTransitMatch(MATCH_STATE_FINISHED, MATCH_STATE_RUNNING), false);
  assert.equal(canTransitMatch(MATCH_STATE_CANCELLED, MATCH_STATE_REGISTERING), false);
});
