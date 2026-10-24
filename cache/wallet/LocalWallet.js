import { applyCredit, applyDebit, WalletAdapter } from "../../game-server/src/wallet/WalletAdapter.js";

export class LocalWallet extends WalletAdapter {
  constructor(options = {}) {
    super(options);
    this.localBalance = Number(options.localBalance ?? 1000000);
    this.store = new Map();
  }

  get mode() {
    return "local";
  }

  async load(session) {
    if (!session) {
      return session;
    }
    const uid = session.userId;
    if (uid && this.store.has(uid)) {
      session.wallet = this.store.get(uid);
      return session;
    }
    if (session.wallet > 0) {
      if (uid) {
        this.store.set(uid, session.wallet);
      }
      return session;
    }
    session.wallet = this.localBalance;
    if (uid) {
      this.store.set(uid, session.wallet);
    }
    session.name = session.name || `local-${uid || "player"}`;
    return session;
  }

  debit(session, amount, _meta) {
    const result = applyDebit(session, amount);
    this.#sync(session);
    return result;
  }

  credit(session, amount, _meta) {
    const result = applyCredit(session, amount);
    this.#sync(session);
    return result;
  }

  async persist(session) {
    this.#sync(session);
  }

  #sync(session) {
    if (session?.userId) {
      this.store.set(session.userId, this.balance(session));
    }
  }
}
