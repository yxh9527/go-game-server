import assert from "node:assert/strict";
import test from "node:test";
import { decodeFrame, encodeFrame, MAX_FRAME_BODY_BYTES } from "../../game-server/src/codec.js";
import { deflateSync } from 'node:zlib';

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

test('binary parser rejects truncated, trailing and oversized bodies',()=>{
  const frame=encodeFrame(1105,{userId:1});
  assert.equal(decodeFrame(frame.subarray(0,-1)),null);
  assert.equal(decodeFrame(Buffer.concat([frame,Buffer.from([0])])),null);
  const large=Buffer.alloc(MAX_FRAME_BODY_BYTES+9);large[0]=0xc0;large.writeUInt32BE(large.length-8,4);
  assert.equal(decodeFrame(large),null);
});

test('compressed packets retain normal behavior and bound decompression bombs',()=>{
  const compressed=payload=>{
    const body=deflateSync(payload),frame=Buffer.alloc(body.length+8);
    frame[0]=0xc0;frame[1]=0xc0;frame.writeInt16BE(1105,2);frame.writeUInt32BE(body.length,4);body.copy(frame,8);return frame;
  };
  assert.deepEqual(decodeFrame(compressed(Buffer.from('{"userId":1}'))).payload,{userId:1});
  assert.equal(decodeFrame(compressed(Buffer.alloc(MAX_FRAME_BODY_BYTES+1,32))),null);
  const invalid=encodeFrame(1105,{userId:1});invalid[1]=0xc0;assert.equal(decodeFrame(invalid),null);
});
