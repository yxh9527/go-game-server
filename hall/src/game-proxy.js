import { WebSocket, WebSocketServer } from "ws";
import { MAX_FRAME_BYTES } from '../../game-server/src/codec.js';

/**
 * 网页客户端会拼 wss://domain；dev 下大厅用 HTTP，下发页面时改成 ws://。
 * 大厅把本端口 WebSocket 转到内部 game-server，iframe 和牌桌同站同端口。
 */
export function attachGameProxy(server, target, log = console) {
  const upstreamUrl = `ws://${target}`;
  const wss = new WebSocketServer({ server, maxPayload: MAX_FRAME_BYTES });
  wss.on("connection", (client) => {
    log.info?.("[hall] game ws proxy connected");
    const pending = [];
    let pendingBytes=0;
    const upstream = new WebSocket(upstreamUrl,{handshakeTimeout:10000});
    function flush() {
      for (const [data, binary] of pending) {
        upstream.send(data, { binary });
      }
      pending.length = 0;
      pendingBytes=0;
    }
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      if(pending.length>=64||pendingBytes+data.length>MAX_FRAME_BYTES){
        pending.length=0;pendingBytes=0;client.close(1008,'Upstream request queue exceeded');upstream.close();return;
      }
      pendingBytes+=data.length;pending.push([data, isBinary]);
    });
    upstream.on("open", flush);
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    const closeBoth = () => {
      pending.length=0;pendingBytes=0;
      try {
        client.close();
      } catch {
        /* ignore */
      }
      try {
        upstream.close();
      } catch {
        /* ignore */
      }
    };
    const closeCode=code=>code>=1000&&code<=1014&&![1004,1005,1006].includes(code)||code>=3000&&code<=4999?code:1000;
    client.on("close", (code,reason) => {pending.length=0;pendingBytes=0;upstream.close(closeCode(code),reason);});
    upstream.on("close", (code,reason) => {pending.length=0;pendingBytes=0;client.close(closeCode(code),reason);});
    client.on("error", closeBoth);
    upstream.on("error", (err) => {
      log.error?.("[hall] game-server proxy", err.message);
      closeBoth();
    });
  });
  return wss;
}
