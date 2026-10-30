import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { smartBetResponse } from "../../hall/src/smart-bet.js";
import { createApp } from "../../hall/src/create-app.js";

const request = (roomType, biz = {}, bizType = 0) => ({
  roomType: String(roomType), bizType: String(bizType),
  bizParam: JSON.stringify({ roomType, reqType: 0, ...biz }),
});
const emptyMarket = {
  overview: { participantCount: 0, participantAmount: 0 }, marketList: [],
};

test("smart market includes the overview and iterable list required by the native client", () => {
  for (const roomType of [58, 59]) {
    const result = smartBetResponse(request(roomType));
    assert.equal(result.msgCode, 200);
    assert.deepEqual(result.data, emptyMarket);
    assert.equal(result.data.overview.participantCount.toString(), "0");
    assert.equal(result.data.overview.participantAmount / 100, 0);
    result.data.marketList.forEach(() => assert.fail("No smart markets are configured"));
  }
  const first = smartBetResponse(request(58));
  first.data.marketList.push({});
  first.data.overview.participantCount = 1;
  assert.deepEqual(smartBetResponse(request(59)).data, emptyMarket);
});

test("all native personal task filters return myTasks rather than a bare array", () => {
  for (const betType of [0, 1, 2]) {
    assert.deepEqual(smartBetResponse(request(58, { reqType: 1, betType })), {
      msgCode: 200, errMsg: null, data: { myTasks: [] },
    });
  }
});

test("smart requests reject malformed or inconsistent game parameters", () => {
  for (const bizParam of [undefined, "undefined", "{", "null", "[]", "1", '"x"']) {
    assert.equal(smartBetResponse({ ...request(58), bizParam }).msgCode, 400);
  }
  for (const patch of [{ roomType: "0" }, { roomType: "58.1" }, { roomType: "59" }, { bizType: "2" }]) {
    assert.equal(smartBetResponse({ ...request(58), ...patch }).msgCode, 400);
  }
});

test("unimplemented smart task mutations and details never report success", () => {
  for (const operateType of [1, 2, 3]) {
    const result = smartBetResponse(request(58, { operateType }, 1));
    assert.equal(result.msgCode, 501);
    assert.equal(result.data, null);
  }
  assert.equal(smartBetResponse(request(58, { reqType: 1, taskId: "missing" })).msgCode, 404);
  assert.equal(smartBetResponse(request(58, { goodRoadType: 8 })).msgCode, 501);
  assert.equal(smartBetResponse(request(58, { reqType: 2 })).msgCode, 501);
});

test("op 71 uses the explicit native response through both HTTP paths and Base64 params", async t => {
  const app = await createApp({
    env: "dev", hotVersion: "smart-bet-test",
    config: { server_port: 11042 }, log: { error() {} },
    matchStore: { listMatches: () => [] }, roomStore: { list: () => [] },
    rpc: { common: {}, lobby: {} },
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = "http://127.0.0.1:" + server.address().port;
  for (const route of ["/internal/v1/do", "/api/internal/v1/do"]) {
    for (const roomType of [58, 59]) {
      for (const reqType of [0, 1]) {
        const params = { op: 71, ...request(roomType, { reqType }) };
        const raw = Object.entries(params).map(([key, value]) => key + "=" + value).join("&");
        const query = new URLSearchParams({ token: "dev", userId: "10001", op: "71", param: Buffer.from(raw).toString("base64") });
        const response = await fetch(origin + route + "?" + query);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), { msgCode: 200, errMsg: null,
          data: reqType === 0 ? emptyMarket : { myTasks: [] } });
      }
    }
    const response = await fetch(origin + route + "?op=71&roomType=58&bizType=0&bizParam=undefined");
    assert.equal((await response.json()).msgCode, 400);
  }
});
