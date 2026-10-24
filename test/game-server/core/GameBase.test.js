import assert from "node:assert/strict";
import test from "node:test";
import { SeatGame } from "../../../game-server/src/core/SeatGame.js?v=0";
import { HundredGame } from "../../../game-server/src/core/HundredGame.js";
import { SlotsGame } from "../../../game-server/src/core/SlotsGame.js";
import holdem from "../../../game-server/src/games/holdem/index.js";
import baccarat from "../../../game-server/src/games/baccarat/index.js";
import mjhl from "../../../game-server/src/games/ggl-mjhl/index.js";
import queen from "../../../game-server/src/games/ggl-queen/index.js";
import zjh from "../../../game-server/src/games/zjh/index.js";

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

test("seat games hot load the matching base class version", async () => {
  for (const version of ["shared-base-1", "shared-base-2"]) {
    const { SeatGame: Base } = await import("../../../game-server/src/core/SeatGame.js?v=" + version);
    const { HoldemGame } = await import("../../../game-server/src/games/holdem/HoldemGame.js?v=" + version);
    const { ZjhGame } = await import("../../../game-server/src/games/zjh/ZjhGame.js?v=" + version);
    assert.ok(new HoldemGame() instanceof Base);
    assert.ok(new ZjhGame() instanceof Base);
    for (const Game of [HoldemGame, ZjhGame]) {
      for (const name of ["tick", "queueStart", "buyIn", "onSitDown", "onCarryScore", "onStandUp", "afterRound",
        "createTable", "roomInfo", "watch", "onJoin", "onLeave"]) {
        assert.equal(Game.prototype[name], Base.prototype[name], name + " must use the shared implementation");
      }
    }
  }
});
