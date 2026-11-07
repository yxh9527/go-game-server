// Keep receipts on the resident wallet/RPC object, including across hot imports.
const stateKey = Symbol.for('gogame.wallet.operations');
export function walletOperation(owner, session, amount, kind, meta, invoke) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid wallet amount');
  if (!meta?.key && !meta?.operation) return invoke();
  const state = owner[stateKey] ||= { keys: new Map(), objects: new WeakMap() };
  const scope = JSON.stringify([Number(session.agentId) || 0, Number(session.userId) || 0,
    session.currency || 'CNY', kind]);
  const receipts = meta.operation
    ? (state.objects.get(meta.operation) || (() => { const map = new Map(); state.objects.set(meta.operation, map); return map; })())
    : state.keys;
  const key = meta.operation ? scope : JSON.stringify([scope, meta.key]);
  const previous = receipts.get(key);
  if (previous) {
    if (previous.amount !== amount) throw new Error('Wallet operation amount changed');
    const current = result => result && typeof result === 'object' ? { ...result, balance: session.wallet } : result;
    return previous.value?.then ? previous.value.then(current) : current(previous.value);
  }
  const record = { amount };
  receipts.set(key, record);
  try {
    const value = invoke();
    if (value?.then) {
      record.value = Promise.resolve(value).then(result => {
        if (result?.ok === false) receipts.delete(key);
        return result;
      }, error => { receipts.delete(key); throw error; });
    } else {
      record.value = value;
      if (value?.ok === false) receipts.delete(key);
    }
    return record.value;
  } catch (error) { receipts.delete(key); throw error; }
}

export function bindBalance(session, account) {
  Object.defineProperty(session, 'wallet', { configurable: true, enumerable: true,
    get: () => account.balance, set: value => { account.balance = value; } });
}

export function unavailable() {
  return Object.assign(new Error('Authoritative wallet mutations are not configured'), { code: 'WALLET_UNAVAILABLE' });
}
