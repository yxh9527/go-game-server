import assert from "node:assert/strict";
import test from "node:test";
import { HundredGame } from "./HundredGame.js";
import { SEND, PUSH } from "../messages.js";

class DemoHundred extends HundredGame {
  constructor() {
    super({ id: "demo-h", kind: "hundred", roomTypes: [58], tickCycle: 8, confRoomType: "x" });
  }

  createAreas() {
    return [{ areaId: 1, total: 0 }];
  }
}

test("HundredGame placeBet only in betting state", () => {
  const game = new DemoHundred();
  const table = game.createTable(1, 58, {});
  const session = { userId: 1, wallet: 1000 };
  const sent = [];
  const ctx = {
    table,
    session,
    send(id, payload) {
      sent.push({ id, payload });
    },
    runtime: { configs: [], registry: { listByRoomType: () => [table], getTable: () => table, setTable() {} } },
  };
  game.placeBet(ctx, { params: [{ areaId: 1, total: 100 }] });
  assert.equal(session.wallet, 900);
  assert.equal(table.totalBetsByArea[0].total, 100);
  table.state = 3;
  game.placeBet(ctx, { params: [{ areaId: 1, total: 100 }] });
  assert.equal(session.wallet, 900);
  assert.ok(sent.some((m) => m.id === PUSH.BET_RESPONSE && m.payload.code === 1));
});

test("HundredGame enter and rooms messages", () => {
  const game = new DemoHundred();
  const table = game.createTable(11, 58, { room_index: 2 });
  const session = { userId: 9, wallet: 10 };
  const sent = [];
  const ctx = {
    table,
    session,
    send(id, payload) {
      sent.push({ id, payload });
    },
    runtime: {
      configs: [],
      registry: {
        listByRoomType: () => [table],
        getTable: () => table,
        setTable() {},
      },
    },
  };
  game.onMessage(ctx, SEND.ENTER, {});
  assert.equal(table.people, 1);
  assert.ok(sent.some((m) => m.id === PUSH.ENTER_RESPONSE));
});
