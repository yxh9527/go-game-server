import assert from "node:assert/strict";
import { createDecipheriv } from "node:crypto";
import test from "node:test";
import { beginHand, createTexasTable, onTexasAction } from "../../../game-server/src/games/holdem/engine.js";
import { OP } from "../../../game-server/src/games/holdem/op.js";
import { PUSH } from "../../../game-server/src/messages.js";
import { beginFairHand, currentFairCode, fairCodeDetail, fairCodeList, finishFairHand } from "../../../game-server/src/core/fair-code.js";

export function proofFixture(count = 2) {
  const table = createTexasTable(700010, 19, { small_blind: 10, big_blind: 20 });
  table.observers.push({ uid: 99, name: "watcher" });
  for (let index = 0; index < count; index += 1) table.members.push({ uid: index + 1, name: "player" + index, point: 1000, pos: index });
  const messages = [];
  const io = { env: "dev", send() {}, forEachPlayer() {}, broadcast(msgid, payload) { messages.push({ msgid, payload }); } };
  beginHand(io, table);
  return { table, io, messages };
}

test("commitments precede betting and dealing, and live proof never discloses keys", () => {
  const { table, messages } = proofFixture();
  const codeAt = messages.findIndex((message) => message.msgid === PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY);
  const betAt = messages.findIndex((message) => message.msgid === PUSH.DZPK_ACTION_BET_PUSH);
  assert.ok(codeAt >= 0 && codeAt < betAt);
  const code = messages[codeAt].payload.notarizationCode;
  for (const uid of [1, 99]) {
    const detail = fairCodeDetail(table, uid, 1);
    assert.equal(detail.pokerList.length, 52);
    assert.equal(detail.pokerList.map((card) => card.encryptedStr).join(""), code);
    assert.ok(detail.pokerList.every((card) => card.secretKey === "" && JSON.parse(card.pokerInfo).index < 0));
  }
  const before = table.fairCodes.get(1);
  beginFairHand({ broadcast() { assert.fail("cannot publish a replacement commitment"); } }, table, table.members, 2);
  assert.equal(table.fairCodes.get(1), before);
  assert.equal(currentFairCode(table, 99).notarizationCode, code);
});

test("normal and all-in runouts match committed burn/flop/turn/river positions", () => {
  for (const allIn of [false, true]) {
    const { table, io } = proofFixture();
    const record = table.fairCodes.get(1);
    const expectedBoard = [5, 6, 7, 9, 11].map((index) => JSON.parse(record.pokerList[index].pokerInfo).index);
    let turns = 0;
    while (table.phase === "playing" && turns++ < 30) {
      const actor = table.members.find((member) => member.uid === table.hand.actorUid);
      const operation = allIn ? OP.ALL_IN : table.hand.currentBet > actor.streetBet ? OP.FOLLOW : OP.PASS;
      onTexasAction(io, table, { userId: actor.uid }, { uid: actor.uid, operation, operationData: 0 });
    }
    assert.ok(turns < 30);
    assert.deepEqual(table.history[0].firstGameList[0].commonPoker, expectedBoard);
    const detail = fairCodeDetail(table, 99, 1);
    for (const card of detail.pokerList.filter((row) => row.secretKey)) {
      const decipher = createDecipheriv("aes-256-ecb", Buffer.from(card.secretKey, "utf8"), null);
      const decoded = Buffer.concat([decipher.update(card.encryptedStr, "base64"), decipher.final()]).toString("utf8");
      assert.equal(decoded, card.pokerInfo);
    }
    assert.equal(detail.pokerList.filter((row) => row.secretKey).length, 9);
    assert.equal(detail.pokerList.map((card) => card.encryptedStr).join(""), record.notarizationCode);
  }
});

test("folded opponent holes, undealt board, and all remaining deck keys stay private", () => {
  const { table, io } = proofFixture();
  const folded = table.hand.actorUid;
  onTexasAction(io, table, { userId: folded }, { uid: folded, operation: OP.ABANDON });
  const own = fairCodeDetail(table, folded, 1);
  const watcher = fairCodeDetail(table, 99, 1);
  assert.equal(own.pokerList.filter((card) => card.secretKey).length, 4);
  assert.equal(watcher.pokerList.filter((card) => card.secretKey).length, 2);
  assert.ok(watcher.pokerList.slice(4).every((card) => card.secretKey === ""));
  assert.equal(fairCodeDetail(table, 123, 1), null);
  assert.deepEqual(fairCodeList(table, 123), []);
  assert.equal(fairCodeList(table, 99)[0].status, 10);
  assert.equal(fairCodeList(table, 99)[0].notarizationCode, "");
});

test("proofs survive module hot loading, expire, and never masquerade as production proofs", async () => {
  const { table, io } = proofFixture();
  const reloaded = await import("../../../game-server/src/core/fair-code.js?v=shared-feature-test");
  assert.deepEqual(reloaded.fairCodeDetail(table, 1, 1), fairCodeDetail(table, 1, 1));
  finishFairHand(table, []);
  table.fairCodes.get(1).finishedAt = Date.now() - 25 * 60 * 60 * 1000;
  assert.equal(fairCodeDetail(table, 1, 1), null);
  table.currentInning = 2;
  beginFairHand({ ...io, env: "prod" }, table, table.members, 2);
  assert.equal(table.fairCodes.size, 0);
});

test("proof history keeps at most 128 hands including the current hand", () => {
  const { table, io } = proofFixture();
  for (let inning = 2; inning <= 131; inning += 1) {
    finishFairHand(table, []);
    table.currentInning = inning;
    beginFairHand(io, table, table.members, 2);
  }
  assert.equal(table.fairCodes.size, 128);
  assert.equal(fairCodeList(table, 99).length, 128);
  assert.equal(fairCodeDetail(table, 99, 3), null);
  assert.equal(fairCodeDetail(table, 99, 4).currentInning, 4);
  assert.equal(currentFairCode(table, 99).currentInning, 131);
});

test("an in-flight legacy hand retains its original deal layout across hot reload", async () => {
  const engine = await import("../../../game-server/src/games/holdem/engine.js?v=legacy-live-hand");
  for (const allIn of [false, true]) {
    const { table, io } = proofFixture();
    // These fields did not exist on hands created before this deployment.
    delete table.hand.burnBeforeBoard;
    delete table.fairCodes;
    delete table.hand.statsPlayers;
    delete table.roomFeatures;
    const expectedBoard = table.hand.deck.slice(4, 9);
    let turns = 0;
    while (table.phase === "playing" && turns++ < 30) {
      const actor = table.members.find((member) => member.uid === table.hand.actorUid);
      engine.onTexasAction(io, table, { userId: actor.uid }, {
        operation: allIn ? OP.ALL_IN : table.hand.currentBet > actor.streetBet ? OP.FOLLOW : OP.PASS,
      });
    }
    assert.ok(turns < 30);
    assert.deepEqual(table.history[0].firstGameList[0].commonPoker, expectedBoard);
    assert.deepEqual(fairCodeList(table, 99), []);
  }
});
