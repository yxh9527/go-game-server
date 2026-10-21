import assert from "node:assert/strict";
import test from "node:test";
import { botChoose, createTexasTable, ensureBot, ensureBots, onGtoReq, onTexasAction, texasConf, texasRoomInfo, tickTexas } from "./engine.js";
import { OP } from "./op.js";
import { PUSH } from "../../messages.js";

function mockIo() {
  const messages = [];
  return {
    messages,
    send(_ws, msgid, payload) {
      messages.push({ msgid, payload, unicast: true });
    },
    broadcast(msgid, payload) {
      messages.push({ msgid, payload });
    },
    forEachPlayer() {},
  };
}

test("two seated players start a hand and fold ends it", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  table.phase = "starting";
  table.startAt = 0;
  const io = mockIo();
  tickTexas(io, table, 1);
  assert.equal(table.phase, "playing");
  assert.equal(table.currentInning, 1);
  assert.ok(table.hand.pot >= 30);
  const actor = table.hand.actorUid;
  onTexasAction(io, table, { userId: actor }, { uid: actor, operation: 6, operationData: 0 });
  assert.equal(table.phase, "starting");
  assert.ok(io.messages.some((m) => m.msgid === 3432));
});

test("solo human gets a bot and bot checks when nothing to call", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push({ uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false });
  ensureBot(table, 1);
  assert.equal(table.members.length, 2);
  assert.equal(table.members[1].bot, true);
  table.hand = { currentBet: 0 };
  table.members[1].streetBet = 0;
  table.members[1].point = 1000;
  const choice = botChoose(table, table.members[1]);
  assert.equal(choice.operation, OP.PASS);
});

test("deal hole cards as a per-seat array", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 1, name: "a", point: 1000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 2, name: "b", point: 1000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  table.phase = "starting";
  table.startAt = 0;
  const messages = [];
  const io = {
    messages,
    send(_ws, msgid, payload) {
      messages.push({ msgid, payload, userId: _ws });
    },
    broadcast(msgid, payload) {
      messages.push({ msgid, payload });
    },
    forEachPlayer(fn) {
      fn({ userId: 1, ws: 1 });
      fn({ userId: 2, ws: 2 });
    },
  };
  tickTexas(io, table, 1);
  const deals = messages.filter((m) => m.msgid === PUSH.DZPK_DEAL_DI_PUSH);
  assert.equal(deals.length, 2);
  for (const m of deals) {
    assert.ok(Array.isArray(m.payload));
    assert.equal(m.payload.length, 2);
    const self = m.payload.find((p) => p.uid === m.userId);
    const other = m.payload.find((p) => p.uid !== m.userId);
    assert.equal(self.cardList.length, 2);
    assert.ok(self.cardList.every((c) => c >= 0));
    assert.deepEqual(other.cardList, [-1, -1]);
  }
});

test("texas conf exposes dzpk betTime for gameRoom.params", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  const conf = texasConf(table);
  assert.equal(conf.hundredSwitch, false);
  assert.equal(conf.dzpk.betTime, table.betTime);
  assert.equal(conf.dzpk.carryMin, 500);
  assert.equal(conf.dzpk.carryMax, -1);
  assert.equal(conf.dzpkParams.betTime, table.betTime);
  assert.equal(conf.dzpk.openAuditCarry, false);
});

test("texas ROOM_INFO pads seven seats with userInfo", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  table.members.push(
    { uid: 10001, name: "dev-10001", point: 2000, pos: 0, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
    { uid: 90000001, name: "Bot", point: 2000, pos: 1, state: 1, lastOperation: 0, totalBet: 0, dealer: false },
  );
  const info = texasRoomInfo(table);
  assert.equal(info.maxPeople, 7);
  assert.equal(info.memberList.length, 7);
  assert.equal(info.memberList[0].pos, 0);
  assert.equal(info.memberList[0].userInfo.uid, 10001);
  assert.equal(info.memberList[1].userInfo.uid, 90000001);
  assert.equal(info.memberList[2].pos, 2);
  assert.equal(info.memberList[2].userInfo, undefined);
});

test("ensureBots seats three to six bots and leaves a chair", () => {
  const table = createTexasTable(700000, 19, { small_blind: 10, big_blind: 20, carry_min: 500 });
  ensureBots(table);
  const bots = table.members.filter((m) => m.bot);
  assert.ok(bots.length >= 3 && bots.length <= 6);
  assert.ok(table.members.length < 7);
  assert.equal(bots[0].userInfo, undefined);
  assert.equal(bots[0].uid, 90000001);
  assert.ok(Number.isFinite(bots[0].point));
});

test("GTO_REQ replies with operation weights", () => {
  const sent = [];
  onGtoReq((msgid, payload) => sent.push({ msgid, payload }), {
    tipsListStr: '[{"operation":6,"data":0},{"operation":9,"data":0}]',
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msgid, PUSH.GTO_RES);
  assert.equal(sent[0].payload["6"], 0.5);
  assert.equal(sent[0].payload["9"], 0.5);
});
