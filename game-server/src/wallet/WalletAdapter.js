export class WalletAdapter {
  constructor(options = {}) {
    this.log = options.log || console;
  }

  get mode() {
    return "base";
  }

  balance(session) {
    return Number(session?.wallet) || 0;
  }

  canDebit(session, amount) {
    const n = Number(amount) || 0;
    return n <= 0 || this.balance(session) >= n;
  }

  async load(_session) {
    throw new Error("load not implemented");
  }

  debit(_session, _amount, _meta) {
    throw new Error("debit not implemented");
  }

  credit(_session, _amount, _meta) {
    throw new Error("credit not implemented");
  }

  async persist(_session) {}
}

export function applyDebit(session, amount) {
  const n = Number(amount) || 0;
  if (n <= 0) {
    return { ok: true, balance: Number(session.wallet) || 0 };
  }
  const cur = Number(session.wallet) || 0;
  if (cur < n) {
    return { ok: false, balance: cur };
  }
  session.wallet = cur - n;
  return { ok: true, balance: session.wallet };
}

export function applyCredit(session, amount) {
  const n = Number(amount) || 0;
  session.wallet = (Number(session.wallet) || 0) + n;
  return { ok: true, balance: session.wallet };
}
