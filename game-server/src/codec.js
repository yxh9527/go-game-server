import { inflateSync } from "node:zlib";
export const MAX_FRAME_BODY_BYTES = 1024 * 1024;
export const MAX_FRAME_BYTES = MAX_FRAME_BODY_BYTES + 8;

export function decodeFrame(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buffer.length < 8 || buffer.length > MAX_FRAME_BYTES || buffer[0] !== 0xc0) {
    return null;
  }
  const flags = buffer.readUInt8(1);
  const msgid = buffer.readInt16BE(2);
  let bodyLength = buffer.readUInt32BE(4);
  if (bodyLength !== buffer.length - 8 || bodyLength > MAX_FRAME_BODY_BYTES) return null;
  let body = buffer.subarray(8, 8 + bodyLength);
  if (flags & 0x40) {
    // Never let an untrusted small deflate stream allocate an unlimited body
    // on the game loop. The same bound also covers JSON decoding below.
    try { body = inflateSync(body, { maxOutputLength: MAX_FRAME_BODY_BYTES }); }
    catch { return null; }
    bodyLength = body.length;
  }
  let payload = null;
  if (bodyLength > 0) {
    const text = body.toString("utf8");
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { msgid, flags, payload };
}

export function encodeFrame(msgid, payload) {
  if (payload === undefined || payload === null) {
    const header = Buffer.alloc(8);
    header.writeUInt8(0xc0, 0);
    header.writeUInt8(0x80, 1);
    header.writeInt16BE(msgid, 2);
    return header;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(8 + body.length);
  header.writeUInt8(0xc0, 0);
  header.writeUInt8(0x80, 1);
  header.writeInt16BE(msgid, 2);
  header.writeUInt32BE(body.length, 4);
  body.copy(header, 8);
  return header;
}
