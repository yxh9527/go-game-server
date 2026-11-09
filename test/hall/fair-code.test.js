import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createApp } from "../../hall/src/create-app.js";
import { createHandler } from "../../game-server/src/create-handler.js";
import { createRegistry } from "../../game-server/src/registry.js";
import { createTexasTable, beginHand, onTexasAction } from "../../game-server/src/games/holdem/engine.js";
import { OP } from "../../game-server/src/games/holdem/op.js";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { SEND, PUSH } from "../../game-server/src/messages.js";
import {createGameSessionStore} from '../../shared/rpc/game-session-store.js';

test("op29 uses authenticated shared proof query without joining, charging or standing a player", async (t) => {
  const registry = createRegistry();
  const table = createTexasTable(700020, 19, {});
  table.members = [
    { uid: 1, name: "one", point: 1000, pos: 0 },
    { uid: 2, name: "two", point: 1000, pos: 1 },
  ];
  table.observers = [{ uid: 3, name: "watcher" }];
  registry.setTable(table.roomId, table, 1, "holdem");
  const io = { env: "dev", broadcast() {}, send() {}, forEachPlayer() {} };
  beginHand(io, table);
  onTexasAction(io, table, { userId: table.hand.actorUid }, { operation: OP.ABANDON });
  let persists = 0,loads=0;
  const gameSessions=createGameSessionStore({instanceId:'fair-query-regression'});
  const handler = await createHandler({
    env: "dev", hotVersion: "fair-http-test", registry, configs: [], findConfig: () => null,
    gateway: {
      validateToken: async (token, uid) => token === "token-" + uid,
      getLoginData: async (uid) => ({ agentId: uid === 4 ? 2 : 1, userName: "user-" + uid }),
    },
    bus:{gameSessions},
    wallet: { load: async (session) => { loads++;session.wallet = 1000; }, persist: async () => { persists += 1; } },
    log: { info() {}, error() {} },
  });
  const loginFrames=[],active={readyState:1,send:raw=>loginFrames.push(decodeFrame(raw)),close(){this.readyState=3;}};
  await handler.onMessage(active,encodeFrame(SEND.ROOM_LOGIN,{userId:1,userToken:'token-1',deviceId:'browser',roomId:table.roomId}));
  const liveSession=registry.session(active);assert.ok(liveSession);assert.equal(loads,1);
  const gameServer = http.createServer();
  const sockets = new WebSocketServer({ server: gameServer });
  const errors = [];
  sockets.on("connection", (socket) => {
    socket.on("message", (data) => handler.onMessage(socket, data).catch((error) => errors.push(error)));
    socket.on("close", () => handler.onClose(socket).catch((error) => errors.push(error)));
  });
  await new Promise((resolve) => gameServer.listen(0, "127.0.0.1", resolve));
  const app = await createApp({
    env: "dev", hotVersion: "fair-http-test", config: { game_server: "127.0.0.1:" + gameServer.address().port },
    log: { error() {} }, matchStore: { listMatches: () => [] }, roomStore: { list: () => [] }, rpc: { common: {}, lobby: {} },
  });
  const hallServer = http.createServer(app);
  await new Promise((resolve) => hallServer.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await Promise.all([new Promise((resolve) => gameServer.close(resolve)), new Promise((resolve) => hallServer.close(resolve))]);
  });
  const before = table.members.map((member) => [member.uid, member.point]);
  const query = async (uid, token, inning = 1) => {
    const params = new URLSearchParams({ op: "29", userId: String(uid), token,
      param: Buffer.from("gameRoomId=700020&currentInning=" + inning).toString("base64") });
    const response = await fetch("http://127.0.0.1:" + hallServer.address().port + "/api/internal/v1/do?" + params);
    return response.json();
  };
  const good = await query(1, "token-1");
  assert.equal(good.msgCode, 200);
  assert.equal(good.data.pokerList.length, 52);
  assert.equal((await query(1, "bad-token")).msgCode, 401);
  assert.equal((await query(4, "token-4")).msgCode, 404, "other agent cannot access this room");
  assert.equal((await query(5, "token-5")).msgCode, 404, "nonparticipant cannot access this hand");
  assert.equal((await query(1, "token-1", 999)).msgCode, 404);
  assert.equal((await query(1, "token-1", "1e100")).msgCode, 400);
  assert.deepEqual(table.members.map((member) => [member.uid, member.point]), before);
  assert.equal(table.observers.length, 1);
  assert.equal(persists, 0);
  assert.equal(loads,1,'proof queries never load a second player wallet');
  assert.equal(registry.session(active),liveSession);assert.equal(registry.sessions.size,1);
  assert.equal(active.readyState,1);assert.equal(loginFrames.some(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT),false);
  assert.equal(await gameSessions.verify(liveSession),true,'proof requests and their close events never touch the primary lease');
  assert.deepEqual(errors, []);

  // Common socket routing also serves the list and ranking panel.
  const messages = [];
  const ws = { readyState: 1, send: (raw) => messages.push(decodeFrame(raw)) };
  registry.bind(ws, { userId: 3, agentId: 1, gameId: "holdem", roomId: table.roomId, authenticated: true, inRoom: true });
  await handler.onMessage(ws, encodeFrame(SEND.SEND_BLOCKCHAIN_VERIFY, { gameRoomId: table.roomId }));
  assert.equal(messages.at(-1).msgid, PUSH.DZPK_RESULT_BLOCKCHAIN_VERIFY);
  assert.equal(messages.at(-1).payload.length, 1);
  delete registry.session(ws).authenticated;
  await handler.onMessage(ws, encodeFrame(SEND.SEND_BLOCKCHAIN_VERIFY, { gameRoomId: table.roomId }));
  assert.equal(messages.at(-1).payload.length, 1, "pre-update authenticated sessions keep working");
  await handler.onMessage(ws, encodeFrame(SEND.SEND_GAME_RANKING_REQ));
  const rank = messages.find((frame) => frame.msgid === PUSH.DZPK_PUSH_RANKINGLIST).payload;
  assert.equal(rank.userList.length, 2);
  assert.equal(rank.obMemberList[0].userName, "watcher");
  assert.equal(rank.totalHands, 1);
});
