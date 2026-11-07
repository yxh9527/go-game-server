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
    const available = this.available ? this.available(session) : this.balance(session);
    return Number.isSafeInteger(amount) && amount >= 0 && Number.isSafeInteger(available) && available >= amount;
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
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid wallet amount');
  const n = amount;
  if (n <= 0) {
    return { ok: true, balance: Number(session.wallet) || 0 };
  }
  const cur = Number(session.wallet) || 0;
  if (!Number.isSafeInteger(cur) || cur < n) {
    return { ok: false, balance: cur };
  }
  session.wallet = cur - n;
  return { ok: true, balance: session.wallet };
}

export function applyCredit(session, amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid wallet amount');
  const n = amount;
  if (!Number.isSafeInteger((Number(session.wallet) || 0) + n)) throw new Error('Invalid wallet balance');
  session.wallet = (Number(session.wallet) || 0) + n;
  return { ok: true, balance: session.wallet };
}
