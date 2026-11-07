import assert from "node:assert/strict";
import test from "node:test";
import { createWallet, credit, debit, walletOf } from "../../../game-server/src/wallet/index.js";
import { createRpcWallet } from '../../../game-server/src/wallet/rpcWallet.js';
import { loadEnv } from '../../../shared/rpc/env.js';

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

test('local account balance is shared across sockets; stale persistence cannot restore spent money', async () => {
  const wallet = createWallet({ mode: 'local', local_balance: 1000 });
  const a = { userId: 41, agentId: 1 }, b = { userId: 41, agentId: 1 };
  await Promise.all([wallet.load(a), wallet.load(b)]);
  assert.equal(wallet.debit(a, 700).ok, true);
  assert.equal(b.wallet, 300);
  assert.equal(wallet.debit(b, 700).ok, false);
  await wallet.persist({ ...b, wallet: 1000 });
  assert.equal(a.wallet, 300);
  wallet.credit(b, 200);
  assert.equal(a.wallet, 500);
  const other = { userId: 41, agentId: 2 };
  await wallet.load(other);
  assert.equal(other.wallet, 1000);
});

test('receipts prevent duplicate debit, refund and payout across RPC wallet replacements', async () => {
  loadEnv({ env: 'dev' });
  let balance = 1000, debits = 0, credits = 0;
  const rpc = { common: { async getBalance() { return balance; },
    debit(_uid, amount) { debits++; if (amount > balance) return { ok: false, balance }; balance -= amount; return { ok: true, balance }; },
    credit(_uid, amount) { credits++; balance += amount; return { ok: true, balance }; } } };
  const a = { userId: 1, agentId: 3 }, b = { userId: 1, agentId: 3 };
  const wallet = createRpcWallet(rpc);
  await Promise.all([wallet.load(a), wallet.load(b)]);
  wallet.debit(a, 700, { key: 'bet-1' });
  const next = createRpcWallet(rpc);
  next.debit(b, 700, { key: 'bet-1' });
  assert.equal(next.debit(b, 700).ok, false);
  next.credit(b, 700, { key: 'refund-1' });
  wallet.credit(a, 700, { key: 'refund-1' });
  const payment = {};
  wallet.credit(a, 500, { operation: payment });
  next.credit(b, 500, { operation: payment });
  assert.equal(debits, 2);
  assert.equal(credits, 2);
  assert.equal(balance, 1500);
  assert.equal(a.wallet, b.wallet);
  assert.throws(() => next.credit(b, 600, { operation: payment }), /amount changed/);
});

test('late balance load cannot overwrite a concurrent debit', async () => {
  let finish;
  const rpc = { common: { getBalance: () => new Promise(resolve => { finish = resolve; }),
    debit: () => ({ ok: true, balance: 300 }) } };
  const wallet = createRpcWallet(rpc), session = { userId: 42, wallet: 1000 };
  const loading = wallet.load(session);
  wallet.debit(session, 700);
  finish(1000); await loading;
  assert.equal(session.wallet, 300);
});

test('invalid amounts and production placeholder writes fail without changing money', async () => {
  const wallet = createWallet({ mode: 'local', local_balance: 1000 }), session = { userId: 43 };
  await wallet.load(session);
  for (const amount of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => wallet.debit(session, amount), /Invalid wallet amount/);
    assert.throws(() => wallet.credit(session, amount), /Invalid wallet amount/);
  }
  assert.equal(session.wallet, 1000);
  loadEnv({ env: 'prod' });
  try {
    const { CommonRpcProd } = await import('../../../shared/rpc/implementations/prod/commonRpcProd.js');
    const common = new CommonRpcProd(), online = createRpcWallet({ common });
    assert.throws(() => online.debit(session, 100), { code: 'WALLET_UNAVAILABLE' });
    assert.throws(() => online.credit(session, 100), { code: 'WALLET_UNAVAILABLE' });
    assert.throws(() => common.debit(session.userId, 100), { code: 'WALLET_UNAVAILABLE' });
    await assert.rejects(common.persistScore(session.userId, 1000), { code: 'WALLET_UNAVAILABLE' });
    await online.persist(session);
    assert.equal(session.wallet, 1000);
  } finally { loadEnv({ env: 'dev' }); }
});
