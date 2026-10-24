import assert from "node:assert/strict";
import test from "node:test";
import config from "../../../../game-server/src/games/ggl-mjhl/config.js";
import { buyTicket, createScratchTable, prizeFromMask, scratchConf } from "../../../../game-server/src/games/ggl-core/engine.js";

test("scratch prize counts matching tiles", () => {
  assert.equal(prizeFromMask(Array(20).fill(8), config.prizeTiers).multiplier, 50);
  assert.equal(prizeFromMask([2, 2, 2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5, 6, 7, 8, 9, 3, 4], config.prizeTiers).huCount, 4);
});

test("scratch buy uses mahjong-hu config", () => {
  const table = createScratchTable(61010026, 61, { game_room_config_id: 6101, room_index: 26 }, config);
  const session = { userId: 9, wallet: 8113, accumulatedWin: 0, accumulatedWinByKind: { GGL1: 0, GGL2: 0 } };
  const result = buyTicket(table, session, { faceValue: 100, kind: "ggl1" });
  assert.equal(result.code, 0);
  assert.equal(result.huMask.length, 20);
  assert.equal(scratchConf(table).gglParams.title, "麻将胡了");
  assert.equal(session.wallet, 8113 - 100 + result.winAmount);
});
