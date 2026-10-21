import assert from "node:assert/strict";
import test from "node:test";
import { asMs, decodeParams, num, truthy } from "./decode.js";

test("decode base64 param", () => {
  const param = Buffer.from("gameType=19&forceShowCard=1&op=38").toString("base64");
  const out = decodeParams(param);
  assert.equal(out.gameType, "19");
  assert.equal(out.op, "38");
  assert.equal(out.forceShowCard, "1");
});

test("asMs converts seconds", () => {
  assert.equal(asMs(1_700_000_000), 1_700_000_000_000);
  assert.equal(asMs(1_791_964_800_000), 1_791_964_800_000);
});

test("truthy and num", () => {
  assert.equal(truthy("1"), true);
  assert.equal(truthy("0"), false);
  assert.equal(num("", 7), 7);
});
