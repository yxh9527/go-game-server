import { applyCredit, applyDebit, WalletAdapter } from "../../game-server/src/wallet/WalletAdapter.js";
import { bindBalance, walletOperation } from '../../game-server/src/wallet/operations.js';

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
    const key = this.#key(session);
    if (!key) { session.wallet ??= this.localBalance; return session; }
    if (!this.store.has(key)) this.store.set(key, { balance: session.wallet > 0 ? session.wallet : this.localBalance });
    bindBalance(session, this.store.get(key));
    session.name ||= `local-${session.userId}`;
    return session;
  }

  debit(session, amount, meta) {
    this.#attach(session);
    return walletOperation(this, session, amount, 'debit', meta, () => applyDebit(session, amount));
  }

  credit(session, amount, meta) {
    this.#attach(session);
    return walletOperation(this, session, amount, 'credit', meta, () => applyCredit(session, amount));
  }

  async persist(session) {
    // Persistence cannot write an old socket's snapshot over the account.
    this.#attach(session);
  }

  #key(session) {
    return session?.userId ? `${Number(session.agentId) || 0}:${Number(session.userId)}:${session.currency || 'CNY'}` : null;
  }

  #attach(session) {
    const account = this.store.get(this.#key(session));
    if (account) bindBalance(session, account);
  }
}
