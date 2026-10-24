import assert from "node:assert/strict";
import test from "node:test";
import { RpcAdapter } from "../../../shared/rpc/adapters/rpcAdapter.js";
import { env, loadEnv } from "../../../shared/rpc/env.js";
import { BusRpcDev } from "../../../cache/rpc/busRpcDev.js";
import { CommonRpcDev } from "../../../cache/rpc/commonRpcDev.js";
import { GatewayRpcDev } from "../../../cache/rpc/gatewayRpcDev.js";
import { LobbyRpcDev } from "../../../cache/rpc/lobbyRpcDev.js";

test("RpcAdapter selects Dev implementations when env.isDev", () => {
  loadEnv({ env: "dev" });
  assert.equal(env.isDev, true);
  const rpc = new RpcAdapter();
  assert.equal(rpc.gateway instanceof GatewayRpcDev, true);
  assert.equal(rpc.common instanceof CommonRpcDev, true);
  assert.equal(rpc.lobby instanceof LobbyRpcDev, true);
  assert.equal(rpc.bus instanceof BusRpcDev, true);
  assert.equal(rpc.getService("gateway"), rpc.gateway);
});

test("dev common gold stays in memory", async () => {
  loadEnv({ env: "dev" });
  const rpc = new RpcAdapter();
  const auth = await rpc.gateway.authenticate("rpc-gold-t", 70001);
  assert.equal(auth.success, true);
  assert.equal(await rpc.common.getBalance(70001), 1000000);
  const paid = rpc.common.debit(70001, 200);
  assert.equal(paid.ok, true);
  assert.equal(await rpc.common.getBalance(70001), 999800);
  const denied = rpc.common.debit(70001, 99999999);
  assert.equal(denied.ok, false);
});

test("dev gateway rejects token bound to another user", async () => {
  loadEnv({ env: "dev" });
  const rpc = new RpcAdapter();
  const first = await rpc.gateway.authenticate("bound-token", 70002);
  assert.equal(first.success, true);
  const second = await rpc.gateway.authenticate("bound-token", 70003);
  assert.equal(second.success, false);
});

test("dev lobby seeds rooms without mysql", async () => {
  loadEnv({ env: "dev" });
  const rpc = new RpcAdapter();
  const rooms = await rpc.lobby.listRooms();
  assert.ok(rooms.some((row) => Number(row.room_type) === 19));
  assert.ok(rooms.some((row) => Number(row.room_type) === 58));
  assert.equal(await rpc.lobby.countUnusedTickets(1), 0);
});

test("dev bus publish reaches in-process subscriber", async () => {
  loadEnv({ env: "dev" });
  const rpc = new RpcAdapter();
  const got = [];
  rpc.bus.subscribe("match", (message) => got.push(message));
  await rpc.bus.publish("match", "{\"event\":\"x\",\"data\":\"{}\"}");
  assert.equal(got.length, 1);
});
