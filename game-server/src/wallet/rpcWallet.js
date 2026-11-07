import { env } from "../../../shared/rpc/env.js";
import { bindBalance, unavailable, walletOperation } from './operations.js';

const accountsKey = Symbol.for('gogame.wallet.accounts');

/**
 * 游戏侧钱包门面。余额权威在 rpc.common，业务不要直接 new Dev/Prod。
 */
export function createRpcWallet(rpc) {
  const accounts = rpc.common[accountsKey] ||= new Map();
  function attach(session, balance) {
    const key = JSON.stringify([Number(session.agentId) || 0, Number(session.userId), session.currency || 'CNY']);
    if (!accounts.has(key)) accounts.set(key, { balance: balance ?? (Number(session.wallet) || 0) });
    const account = accounts.get(key);
    bindBalance(session, account);
    return account;
  }
  return {
    mode: env.isDev ? "local" : "online",
    async load(session) {
      if (!session?.userId) {
        session.wallet = Number(session.wallet) || 0;
        return session;
      }
      const account = attach(session);
      const revision = account.revision || 0;
      const balance = Number(await rpc.common.getBalance(session.userId));
      if (!Number.isSafeInteger(balance) || balance < 0) throw new Error('Invalid wallet balance');
      if (revision === (account.revision || 0)) account.balance = balance;
      return session;
    },
    debit(session, amount, meta) {
      if (!env.isDev) throw unavailable();
      const account = attach(session);
      return walletOperation(rpc.common, session, amount, 'debit', meta, () => {
        const paid = rpc.common.debit(session.userId, amount, meta);
        if (paid.ok) { account.balance = paid.balance; account.revision = (account.revision || 0) + 1; }
        return paid;
      });
    },
    credit(session, amount, meta) {
      if (!env.isDev) throw unavailable();
      const account = attach(session);
      return walletOperation(rpc.common, session, amount, 'credit', meta, () => {
        const paid = rpc.common.credit(session.userId, amount, meta);
        if (paid.ok) { account.balance = paid.balance; account.revision = (account.revision || 0) + 1; }
        return paid;
      });
    },
    async persist(session) {
      // A balance snapshot is never a money operation.
    },
  };
}
