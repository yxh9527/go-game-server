import { applyCredit, applyDebit } from "./WalletAdapter.js";
import { createRequire } from "node:module";
import { env } from "../../../shared/rpc/env.js";
import { OnlineWallet } from "./OnlineWallet.js";
import { createRpcWallet } from "./rpcWallet.js";
import { enableCarry } from './carry.js';
export { hasCarry, cashTableKey, CARRY_TTL_MS, CARRY_RENEW_MS } from './carry.js';

export { OnlineWallet, createRpcWallet };

const require = createRequire(import.meta.url);
const tableWallet = Symbol.for('gogame.test.table.wallet');
function localWallet(options, sessionOnly = false) {
  if (!env.isDev) throw new Error("Local wallet is only available in dev; configure a production wallet");
  const { LocalWallet, sessionOnlyWallet } = require("../../../cache/wallet/LocalWallet.js");
  const create=()=>enableCarry(new LocalWallet(options));
  return sessionOnly ? sessionOnlyWallet(create) : create();
}

export function createWallet(config = {}, deps = {}) {
  if (deps.rpc) {
    return createRpcWallet(deps.rpc);
  }
  const mode = String(config.mode || config.wallet?.mode || "local").toLowerCase();
  if (mode === "online" || mode === "prod" || mode === "production") {
    return new OnlineWallet({
      log: deps.log,
    });
  }
  return localWallet({
    localBalance: Number(config.local_balance ?? config.wallet?.local_balance ?? 1000000),
    log: deps.log,
  });
}

export function walletOf(host) {
  const wallet = host?.wallet || host?.runtime?.wallet || host?.io?.wallet;
  if (wallet) return enableCarry(wallet);
  if (!env.isDev) throw new Error("A production wallet is required");
  if (host?.table) return host.table[tableWallet] ||= localWallet({ localBalance: 0 });
  return localWallet({ localBalance: 0 }, true);
}

export function debit(session, amount, host, meta) {
  return walletOf(host).debit(session, amount, {...meta,table:host?.table||host?.io?.table||host?.lotteryTable});
}

export function credit(session, amount, host, meta) {
  return walletOf(host).credit(session, amount, {...meta,table:host?.table||host?.io?.table||host?.lotteryTable});
}

export function canDebit(session, amount, host) {
  return walletOf(host).canDebit(session, amount);
}

export { applyCredit, applyDebit };
