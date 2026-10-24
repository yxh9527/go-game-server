import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createApp } from "../../hall/src/create-app.js";
import { createHandler } from "../../game-server/src/create-handler.js";
import { createRegistry, findConfig } from "../../game-server/src/registry.js";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { SEND, PUSH } from "../../game-server/src/messages.js";
import { ROOM_LIFETIME_MS } from "../../game-server/src/core/room-lifecycle.js";

test("hall allocates live empty reserves through authenticated game-server queries", async (t) => {
  const registry = createRegistry();
  const rows = [{ game_type: 19, room_type: 19, game_room_config_id: 70, room_index: 0,
    play_mode: 0, small_blind: 10, big_blind: 20, carry_min: 500, state: 1 }];
  const errors = [];
  let loads = 0;
  let persists = 0;
  const runtime = { env: "dev", hotVersion: "room-pool-http-test", registry, configs: rows, findConfig,
    gateway: {
      validateToken: async (token, uid) => token === "token-" + uid,
      getLoginData: async (uid) => ({ agentId: uid === 2 ? 2 : 1, userName: "user-" + uid }),
    },
    wallet: { async load(session) { loads += 1; session.wallet = 10000; }, async persist() { persists += 1; } },
    log: { info() {}, error: (...args) => errors.push(args) },
  };
  const handler = await createHandler(runtime);
  const gameServer = http.createServer();
  const sockets = new WebSocketServer({ server: gameServer });
  sockets.on("connection", (socket) => {
    socket.on("message", (raw) => handler.onMessage(socket, raw).catch((error) => errors.push(error)));
    socket.on("close", () => handler.onClose(socket).catch((error) => errors.push(error)));
  });
  await new Promise((resolve) => gameServer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({ env: "dev", hotVersion: runtime.hotVersion,
    config: { game_server: "127.0.0.1:" + gameServer.address().port },
    log: runtime.log, matchStore: { listMatches: () => [] }, roomStore: { list: () => rows }, rpc: { common: {}, lobby: {} },
  });
  const hallServer = http.createServer(app);
  await new Promise((resolve) => hallServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await Promise.all([new Promise((resolve) => gameServer.close(resolve)), new Promise((resolve) => hallServer.close(resolve))]);
  });
  const query = async (op, uid = 1, token = "token-" + uid, extra = {}) => {
    const params = new URLSearchParams({ op: String(op), userId: String(uid), token,
      param: Buffer.from(new URLSearchParams({ gameType: "19", roomType: "19", gameRoomConfigId: "70", ...extra }).toString()).toString("base64") });
    const response = await fetch("http://127.0.0.1:" + hallServer.address().port + "/api/internal/v1/do?" + params);
    return response.json();
  };
  assert.equal((await query(38)).data[0].roomInfoData[0].totalPeople, 0);
  assert.equal(registry.tables.size, 0, "opening hall does not create a room");
  assert.equal((await query(45, 1, "bad-token")).msgCode, 401);
  assert.equal(registry.tables.size, 0);
  const first = await query(45);
  assert.equal(first.msgCode, 200);
  assert.equal(first.data.roomId, 700000);
  assert.equal(first.data.hundredDomain, first.data.domain, "ordinary rooms must advertise their shared hundred socket endpoint");
  assert.equal((await query(45)).data.roomId, first.data.roomId, "reuse available room");
  const table = registry.getTable(first.data.roomId, 1, "holdem");
  assert.deepEqual(table.members, []);
  assert.deepEqual(table.observers, []);
  assert.equal(table.phase, "idle");
  assert.equal(table.expiresAt - table.createdAt, ROOM_LIFETIME_MS);
  assert.equal(loads, 0);
  assert.equal(persists, 0);
  assert.equal(registry.sessions.size, 0, "allocation is not a room login");

  // Real binary login activates the room; bot arrivals happen on later ticks.
  const client = new WebSocket("ws://127.0.0.1:" + gameServer.address().port);
  await new Promise((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
  const request = (msgid, payload, expected) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off("message", listener); reject(new Error("missing socket response " + expected)); }, 2000);
    const listener = (raw) => {
      const frame = decodeFrame(raw);
      if (frame?.msgid !== expected) return;
      clearTimeout(timer);
      client.off("message", listener);
      resolve(frame.payload);
    };
    client.on("message", listener);
    client.send(encodeFrame(msgid, payload));
  });
  await request(SEND.ROOM_LOGIN, { userId: 1, userToken: "token-1", roomId: table.roomId }, PUSH.ROOM_LOGIN);
  await request(SEND.SEND_JOIN_ROOM, { roomId: table.roomId, roomType: 19 }, PUSH.GAME_POINT_UPDATE);
  assert.equal(table.observers.some((member) => member.uid === 1), true);
  assert.equal(table.members.some((member) => member.uid === 1), false);
  assert.equal(table.members.length, 0, "joining does not synchronously fill the room");
  assert.equal(table.standby, false);
  table.cfg.robot_behavior = { joinProbability: 1, leaveProbability: 0 };
  await handler.tick();
  table.robotTraffic.nextCheckAt = Date.now();
  await handler.tick();
  assert.equal(table.members.length, 1);
  assert.equal(table.members[0].bot, true);
  assert.equal(table.members[0].point, 0, "robot occupies a seat before its delayed buy-in");
  await request(SEND.SEND_LEVEL_OUT, undefined, PUSH.USER_LEVEL_ROOM);
  assert.deepEqual(await request(SEND.MB_UNREG_ROOMS_REQ, undefined, PUSH.MB_UNREG_ROOMS_RES), {});
  assert.equal(table.observers.some((member) => member.uid === 1), false);
  assert.equal(registry.getTable(table.roomId, 1, "holdem"), table, "auxiliary cleanup must not destroy the main room");
  const close = new Promise((resolve) => client.once("close", resolve));
  client.close();
  await close;

  // A full room creates one empty reserve, which the hall must return.
  table.members = Array.from({ length: 7 }, (_, pos) => ({ uid: 90000000 + pos, bot: true, pos, point: 1000 }));
  table.phase = "idle";
  table.hand = null;
  await handler.tick();
  const reserve = registry.listAgentGameRooms(1, "holdem").find((item) => item.roomId !== table.roomId);
  assert.ok(reserve);
  assert.deepEqual(reserve.members, []);
  assert.deepEqual(reserve.observers, []);
  assert.equal(reserve.standby, true);
  const allocated = await query(45);
  assert.equal(allocated.data.roomId, reserve.roomId);
  assert.equal(allocated.data.roomIndex, 1);
  assert.equal((await query(38)).data[0].roomInfoData[0].totalPeople, 7);

  assert.equal((await query(38, 2)).data[0].roomInfoData[0].totalPeople, 0);
  const otherAgent = await query(45, 2, "token-2", { agentId: "1" });
  assert.equal(otherAgent.data.roomId, 700000);
  assert.notEqual(registry.getTable(700000, 2, "holdem"), table);

  for (const item of registry.listAgentGameRooms(1, "holdem")) item.createdAt = Date.now() - ROOM_LIFETIME_MS;
  assert.equal((await query(38)).data[0].roomInfoData[0].totalPeople, 0, "expired rooms excluded before cleanup tick");
  await handler.tick();
  const next = await query(45);
  assert.equal(next.data.roomId, 700002, "destroyed room identities are not reused");
  assert.equal(registry.listAgentGameRooms(2, "holdem").length, 1);
  assert.deepEqual(errors, []);
});
