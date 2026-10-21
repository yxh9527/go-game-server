import { applyCredit, applyDebit, WalletAdapter } from "./WalletAdapter.js";

export class OnlineWallet extends WalletAdapter {
  constructor(options = {}) {
    super(options);
    this.db = options.db;
  }

  get mode() {
    return "online";
  }

  async load(session) {
    if (!this.db || !session?.userId) {
      session.wallet = Number(session.wallet) || 0;
      return session;
    }
    const [rows] = await this.db.query("SELECT score, nick_name FROM user_info WHERE user_id=? LIMIT 1", [session.userId]);
    if (rows[0]) {
      session.wallet = Number(rows[0].score || 0);
      session.name = rows[0].nick_name || session.name;
    } else {
      session.wallet = 0;
    }
    return session;
  }

  debit(session, amount, _meta) {
    const result = applyDebit(session, amount);
    if (result.ok) {
      this.#flush(session);
    }
    return result;
  }

  credit(session, amount, _meta) {
    const result = applyCredit(session, amount);
    this.#flush(session);
    return result;
  }

  #flush(session) {
    this.persist(session).catch((err) => this.log.error("online wallet persist failed", err.message));
  }

  async persist(session) {
    if (!this.db || !session?.userId || session.userId >= 90000000) {
      return;
    }
    await this.db.query("UPDATE user_info SET score=? WHERE user_id=?", [this.balance(session), session.userId]);
  }
}
