import assert from "node:assert/strict";
import test from "node:test";
import { SeatGame } from "./SeatGame.js";
import { HundredGame } from "./HundredGame.js";
import { SlotsGame } from "./SlotsGame.js";
import holdem from "../games/holdem/index.js";
import baccarat from "../games/baccarat/index.js";
import mjhl from "../games/ggl-mjhl/index.js";
import queen from "../games/ggl-queen/index.js";
import zjh from "../games/zjh/index.js";

test("concrete games extend the three bases", () => {
  assert.equal(holdem instanceof SeatGame, true);
  assert.equal(baccarat instanceof HundredGame, true);
  assert.equal(mjhl instanceof SlotsGame, true);
  assert.equal(queen instanceof SlotsGame, true);
  assert.equal(zjh instanceof SeatGame, true);
  assert.equal(holdem.kind, "normal");
  assert.equal(baccarat.kind, "hundred");
  assert.equal(mjhl.kind, "slots");
  assert.deepEqual(mjhl.roomTypes, [61]);
  assert.deepEqual(queen.roomTypes, [63]);
});
