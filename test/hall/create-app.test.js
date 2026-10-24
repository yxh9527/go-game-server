import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createApp } from "../../hall/src/create-app.js";

test("dev op 46 loads a matching Holdem detail from game-server memory", async () => {
  const detail = { exploitsInfoMsgs: [{ gameInningId: "700001_4" }] };
  const gameServer = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/internal/dev/holdem-record-detail");
    assert.equal(url.searchParams.get("roomId"), "700001");
    assert.equal(url.searchParams.get("inningNum"), "4");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 0, data: detail }));
  });
  await new Promise((resolve) => gameServer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({
    env: "dev",
    hotVersion: 1,
    config: { server_port: 11042, game_server: `127.0.0.1:${gameServer.address().port}` },
    log: { error() {} },
    matchStore: { listMatches: () => [] },
    roomStore: { list: () => [] },
    rpc: { common: {}, lobby: {} },
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    const param = Buffer.from("op=46&gameRoomId=700001&inningNum=4").toString("base64");
    const response = await fetch(`http://127.0.0.1:${port}/internal/v1/do?param=${param}`);
    const body = await response.json();
    assert.equal(body.msgCode, 200);
    assert.deepEqual(body.data, detail);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => gameServer.close((error) => error ? reject(error) : resolve()));
  }
});
