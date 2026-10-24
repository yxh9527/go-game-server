import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, encodeFrame } from "../../game-server/src/codec.js";

test("encode matches client 0xc0/0x80 header", () => {
  const buf = encodeFrame(1105, { userId: 1, roomId: 700000 });
  assert.equal(buf[0], 0xc0);
  assert.equal(buf[1], 0x80);
  assert.equal(buf.readInt16BE(2), 1105);
  const decoded = decodeFrame(buf);
  assert.equal(decoded.msgid, 1105);
  assert.equal(decoded.payload.userId, 1);
  assert.equal(decoded.payload.roomId, 700000);
});

test("empty payload keeps 8-byte header", () => {
  const buf = encodeFrame(1200);
  assert.equal(buf.length, 8);
  const decoded = decodeFrame(buf);
  assert.equal(decoded.msgid, 1200);
  assert.equal(decoded.payload, null);
});
