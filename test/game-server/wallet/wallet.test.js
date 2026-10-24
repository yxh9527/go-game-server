import assert from "node:assert/strict";
import test from "node:test";
import { createWallet, credit, debit, walletOf } from "../../../game-server/src/wallet/index.js";

test("local wallet does not require db and starts with local_balance", async () => {
  const wallet = createWallet({ mode: "local", local_balance: 5000 });
  const session = { userId: 7 };
  await wallet.load(session);
  assert.equal(wallet.mode, "local");
  assert.equal(session.wallet, 5000);
  assert.equal(debit(session, 200, { wallet }).ok, true);
  assert.equal(session.wallet, 4800);
  assert.equal(debit(session, 99999, { wallet }).ok, false);
  credit(session, 100, { wallet });
  assert.equal(session.wallet, 4900);
});

test("local wallet keeps balance after reload in same process", async () => {
  const wallet = createWallet({ mode: "local", local_balance: 1000 });
  const a = { userId: 8 };
  await wallet.load(a);
  debit(a, 300, { wallet });
  const b = { userId: 8 };
  await wallet.load(b);
  assert.equal(b.wallet, 700);
});

test("createWallet online uses OnlineWallet", () => {
  const wallet = createWallet({ mode: "online" }, { db: null });
  assert.equal(wallet.mode, "online");
});

test("walletOf falls back to session-only for tests", () => {
  const session = { userId: 1, wallet: 100 };
  assert.equal(debit(session, 40, {}).ok, true);
  assert.equal(session.wallet, 60);
  assert.equal(walletOf({}).mode, "local");
});

test("createWallet with rpc uses CommonRpcDev gold", async () => {
  const { loadEnv } = await import("../../../shared/rpc/env.js");
  const { RpcAdapter } = await import("../../../shared/rpc/adapters/rpcAdapter.js");
  loadEnv({ env: "dev" });
  const rpc = new RpcAdapter();
  const wallet = createWallet({}, { rpc });
  const session = { userId: 80001 };
  await wallet.load(session);
  assert.equal(wallet.mode, "local");
  assert.equal(session.wallet, 1000000);
  assert.equal(debit(session, 200, { wallet }).ok, true);
  assert.equal(session.wallet, 999800);
  assert.equal(await rpc.common.getBalance(80001), 999800);
});
