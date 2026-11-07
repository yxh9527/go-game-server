import { randomUUID } from 'node:crypto';
import { walletOperation } from './operations.js';

export const CARRY_TTL_MS = 300_000;
export const CARRY_RENEW_MS = 60_000;
const stateKey = Symbol.for('gogame.cash.carry');
const memberKey = Symbol.for('gogame.cash.carry.member');
const accountKey = s => JSON.stringify([Number(s.agentId) || 0, Number(s.userId), s.currency || 'CNY']);
export const cashTableKey = t => `${Number(t.agentId) || 0}:${t.gameId}:${Number(t.roomId)}`;
export const hasCarry = member => Boolean(member?.[memberKey]);
const fail = message => Object.assign(new Error(message), { code: 'CARRY_CONFLICT' });
function money(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid carry amount');
}

// This model is shared by local wallets and the RPC facade. A carry is a
// reservation inside the account balance, never a second money balance.
export function enableCarry(wallet, owner = wallet) {
  if (wallet.carryEnabled) return wallet;
  const state = owner[stateKey] ||= { entries: new Map(), receipts: {}, remote: new Map() };
  state.remote ||= new Map();
  const missing = () => { throw new Error('Wallet money operations unavailable'); };
  const debit = wallet.debit?.bind(wallet) || missing, credit = wallet.credit?.bind(wallet) || missing;
  const load = wallet.load?.bind(wallet);
  function bindSession(session) {
    Object.defineProperties(session, {
      carryAmount: { configurable: true, enumerable: true, get: () => amountOf(session) },
      availableBalance: { configurable: true, enumerable: true, get: () => available(session) },
    });
  }
  function current(session) {
    const key = accountKey(session), entry = state.entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) { state.entries.delete(key); entry.expired = true; return null; }
    return entry || null;
  }
  function live(entry) {
    if (entry.released || entry.expired || current(entry.session) !== entry) throw fail('带入凭证已过期，请重新入座');
  }
  function touch(entry) { live(entry); entry.expiresAt = Date.now() + CARRY_TTL_MS; }
  function remote(session) {
    const record = state.remote.get(accountKey(session));
    if (record && record.expiresAt <= Date.now()) { state.remote.delete(accountKey(session)); return null; }
    return record;
  }
  function amountOf(session) { return current(session)?.amount ?? remote(session)?.amount ?? 0; }
  function available(session) { return Math.max(0, Number(session.wallet || 0) - amountOf(session)); }
  function bind(entry, member) {
    if (member[memberKey] === entry) return;
    Object.defineProperty(member, memberKey, { value: entry, configurable: true });
    Object.defineProperty(member, 'point', { configurable: true, enumerable: true,
      get: () => entry.amount,
      set: value => {
        money(value);
        if (entry.released && value === entry.amount) return;
        live(entry);
        const delta = value - entry.amount;
        if (!delta) { touch(entry); return; }
        const paid = delta < 0 ? debit(entry.session, -delta, { carryToken: entry.token })
          : credit(entry.session, delta, { carryToken: entry.token });
        if (paid?.then) throw new Error('Cash point mutations require an atomic cash transaction adapter');
        if (paid?.ok !== true) throw fail('带入筹码变更失败');
        entry.amount = value;
        touch(entry);
      } });
    member.carryMode = 'reservation';
  }
  Object.assign(wallet, {
    carryEnabled: true,
    setCarryStore(store) { state.store = store; },
    async refreshCarry(session) {
      if (!state.store) return this.carryRecord(session);
      const record = await state.store.get(session);
      if (record) state.remote.set(accountKey(session), record);
      else state.remote.delete(accountKey(session));
      return record;
    },
    async checkCashEntry(session, table) {
      const record = await this.refreshCarry(session);
      if (record && record.tableKey !== cashTableKey(table)) throw fail('当前仍有其他棋牌桌带入，请先离座');
      return this.assertCashEntry(session, table);
    },
    async load(session) {
      await load?.(session);
      if (session) bindSession(session);
      return session;
    },
    available,
    carryRecord(session) {
      const entry = current(session) || remote(session);
      return entry ? { tableKey: entry.tableKey, token: entry.token, amount: entry.amount,
        expiresAt: entry.expiresAt, ttlMs: CARRY_TTL_MS } : null;
    },
    assertCashEntry(session, table) {
      const entry = current(session);
      if (entry && entry.tableKey !== cashTableKey(table)) throw fail('当前仍有其他棋牌桌带入，请先离座');
      return entry;
    },
    reserveCarry(session, member, table, amount) {
      money(amount);
      if (wallet.mode === 'online') throw Object.assign(new Error('Authoritative cash reservation transactions are not configured'), { code: 'WALLET_UNAVAILABLE' });
      if (session.bot || table.mtt || Number(table.roomType) === 101) throw new Error('Cash reservation is only for human cash seats');
      bindSession(session);
      let entry = this.assertCashEntry(session, table);
      if (entry && member[memberKey] !== entry) throw fail('已有带入，请恢复原座位');
      if (amount > available(session)) return { ok: false, balance: session.wallet };
      if (!entry) {
        entry = { token: randomUUID(), tableKey: cashTableKey(table), amount: 0, session, table,
          expiresAt: Date.now() + CARRY_TTL_MS };
        state.entries.set(accountKey(session), entry);
        bind(entry, member);
      }
      entry.amount += amount;
      touch(entry);
      return { ok: true, balance: session.wallet, carry: entry.amount };
    },
    releaseCarry(session, member, amount = member?.point || 0, keepOwner = false) {
      const entry = member?.[memberKey];
      if (!entry) return false;
      money(amount);
      // Expired/replaced seats cannot delete a newer lease or credit money.
      if (entry.expired || entry.released || current(session) !== entry) return true;
      if (amount > entry.amount) throw fail('带出超过当前带入值');
      entry.amount -= amount;
      if (keepOwner) { entry.pendingDeparture = true; touch(entry); }
      else if (entry.amount === 0) {
        state.entries.delete(accountKey(session));
        entry.released = true;
      } else touch(entry);
      return true;
    },
    renewCarry(member) {
      const entry = member?.[memberKey];
      if (!entry || entry.released) return;
      live(entry);
      if (entry.expiresAt - Date.now() <= CARRY_TTL_MS - CARRY_RENEW_MS) touch(entry);
    },
    guardCashTable(table) {
      if (table.carryFault) throw fail('牌桌带入已失效，等待恢复处理');
      const members = new Set([...(table.members || []), ...(table.hand?.participants || []),
        ...(table.hand?.statsPlayers || []).map(p => p.member || p)]);
      try { for (const member of members) if (hasCarry(member)) this.renewCarry(member); }
      catch (error) { table.carryFault = error.message; throw error; }
    },
    releaseFinishedCarries(table) {
      if (table.hand || table.phase === 'playing') return;
      for (const entry of state.entries.values()) if (entry.table === table && entry.pendingDeparture) {
        live(entry);
        state.entries.delete(accountKey(entry.session));
        entry.amount = 0;
        entry.released = true;
      }
    },
    debit(session, amount, meta) {
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid wallet amount');
      return walletOperation(state.receipts, session, amount, 'debit', meta, () => {
        if (amount > available(session)) return { ok: false, balance: session.wallet };
        return debit(session, amount, meta);
      });
    },
  });
  return wallet;
}
