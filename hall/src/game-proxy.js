import { WebSocket, WebSocketServer } from "ws";

/**
 * 网页客户端会拼 wss://domain；dev 下大厅用 HTTP，下发页面时改成 ws://。
 * 大厅把本端口 WebSocket 转到内部 game-server，iframe 和牌桌同站同端口。
 */
export function attachGameProxy(server, target, log = console) {
  const upstreamUrl = `ws://${target}`;
  const wss = new WebSocketServer({ server });
  wss.on("connection", (client) => {
    log.info?.("[hall] game ws proxy connected");
    const pending = [];
    const upstream = new WebSocket(upstreamUrl);
    function flush() {
      for (const [data, binary] of pending) {
        upstream.send(data, { binary });
      }
      pending.length = 0;
    }
    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      pending.push([data, isBinary]);
    });
    upstream.on("open", flush);
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    const closeBoth = () => {
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
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
    client.on("error", closeBoth);
    upstream.on("error", (err) => {
      log.error?.("[hall] game-server proxy", err.message);
      closeBoth();
    });
  });
  return wss;
}
