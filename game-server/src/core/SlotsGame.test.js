import assert from "node:assert/strict";
import test from "node:test";
import { SlotsGame } from "./SlotsGame.js";
import { SEND, PUSH } from "../messages.js";

class DemoSlots extends SlotsGame {
  constructor() {
    super({ id: "demo-s", kind: "slots", roomTypes: [61], confRoomType: "x", defaultRoomIndex: 1 });
  }

  buy(ctx, payload) {
    const face = Number(payload.faceValue || 100);
    ctx.session.wallet -= face;
    return { code: 0, winAmount: 0, walletAmount: ctx.session.wallet };
  }
}

test("SlotsGame buy and state go through base onMessage", () => {
  const game = new DemoSlots();
  const table = game.createTable(61, 61, {});
  const session = { userId: 1, wallet: 500 };
  const sent = [];
  const ctx = {
    table,
    session,
    send(id, payload) {
      sent.push({ id, payload });
    },
  };
  game.onMessage(ctx, SEND.GGL_STATE, {});
  game.onMessage(ctx, SEND.GGL_BUY, { faceValue: 100 });
  assert.equal(session.wallet, 400);
  assert.ok(sent.some((m) => m.id === PUSH.GGL_STATE));
  assert.ok(sent.some((m) => m.id === PUSH.GGL_RESULT && m.payload.walletAmount === 400));
});
