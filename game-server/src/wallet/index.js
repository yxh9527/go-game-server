import { applyCredit, applyDebit } from "./WalletAdapter.js";
import { LocalWallet } from "./LocalWallet.js";
import { OnlineWallet } from "./OnlineWallet.js";
import { createRpcWallet } from "./rpcWallet.js";

export { LocalWallet, OnlineWallet, createRpcWallet };

const sessionOnly = new LocalWallet({ localBalance: 0 });

export function createWallet(config = {}, deps = {}) {
  if (deps.rpc) {
    return createRpcWallet(deps.rpc);
  }
  const mode = String(config.mode || config.wallet?.mode || "local").toLowerCase();
  if (mode === "online" || mode === "prod" || mode === "production") {
    return new OnlineWallet({
      db: deps.db,
      log: deps.log,
    });
  }
  return new LocalWallet({
    localBalance: Number(config.local_balance ?? config.wallet?.local_balance ?? 1000000),
    log: deps.log,
  });
}

export function walletOf(host) {
  return host?.wallet || host?.runtime?.wallet || host?.io?.wallet || sessionOnly;
}

export function debit(session, amount, host, meta) {
  return walletOf(host).debit(session, amount, meta);
}

export function credit(session, amount, host, meta) {
  return walletOf(host).credit(session, amount, meta);
}

export function canDebit(session, amount, host) {
  return walletOf(host).canDebit(session, amount);
}

export { applyCredit, applyDebit };
