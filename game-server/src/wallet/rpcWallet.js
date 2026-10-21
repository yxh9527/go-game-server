import { env } from "../../../shared/rpc/env.js";
import { applyCredit, applyDebit } from "./WalletAdapter.js";

/**
 * 游戏侧钱包门面。余额权威在 rpc.common，业务不要直接 new Dev/Prod。
 */
export function createRpcWallet(rpc) {
  return {
    mode: env.isDev ? "local" : "online",
    async load(session) {
      if (!session?.userId) {
        session.wallet = Number(session.wallet) || 0;
        return session;
      }
      session.wallet = Number(await rpc.common.getBalance(session.userId)) || 0;
      return session;
    },
    debit(session, amount) {
      if (env.isDev && session?.userId) {
        const paid = rpc.common.debit(session.userId, amount);
        if (paid.ok) {
          session.wallet = paid.balance;
        }
        return paid;
      }
      const result = applyDebit(session, amount);
      if (result.ok && session?.userId) {
        rpc.common.debit(session.userId, amount);
      }
      return result;
    },
    credit(session, amount) {
      if (env.isDev && session?.userId) {
        const paid = rpc.common.credit(session.userId, amount);
        session.wallet = paid.balance;
        return paid;
      }
      const result = applyCredit(session, amount);
      if (session?.userId) {
        rpc.common.credit(session.userId, amount);
      }
      return result;
    },
    async persist(session) {
      if (env.isDev || !session?.userId) {
        return;
      }
      await rpc.common.persistScore?.(session.userId, session.wallet);
    },
  };
}
