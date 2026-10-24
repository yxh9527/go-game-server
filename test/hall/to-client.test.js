import assert from "node:assert/strict";
import test from "node:test";
import { MATCH_STATE_DRAFT, MATCH_STATE_REGISTERING, isListedMatch, toClientMatch } from "../../hall/src/to-client.js";

test("draft matches stay out of hall list", () => {
  assert.equal(isListedMatch({ state: MATCH_STATE_DRAFT }), false);
  assert.equal(isListedMatch({ state: MATCH_STATE_REGISTERING }), true);
});

test("client match keeps championshipName as json string", () => {
  const name = "[{\"lang\":\"zh_cn\",\"championshipName\":\"德州每日免费赛\"}]";
  const out = toClientMatch({
    id: 2,
    state: MATCH_STATE_REGISTERING,
    championship_name: name,
    start_time: 1791964800000,
    create_time: 1791888191,
    room_type: 101,
    force_show_card: 1,
    fix_pot: 1,
  }, { gameServer: "127.0.0.1:11041" });
  assert.equal(typeof out.championshipName, "string");
  assert.equal(JSON.parse(out.championshipName)[0].championshipName, "德州每日免费赛");
  assert.equal(out.roomType, 101);
  assert.equal(out.forceShowCard, true);
  assert.equal(out.startDate, "1791964800000");
  assert.equal(out.createTime, "1791888191000");
  assert.equal(out.register, false);
  assert.equal(out.domain, "127.0.0.1:11041");
});
