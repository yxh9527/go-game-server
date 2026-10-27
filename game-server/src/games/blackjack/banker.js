import { debit, credit, walletOf } from '../../wallet/index.js';
import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const lifecycle = await rel(import.meta.url, '../../core/room-lifecycle.js', v);
const { userInfoOf } = await rel(import.meta.url, '../../core/member.js', v);

// Authority: original LiveBlackJack layout/scripts/banker/readMe TextAsset.
export const REQUEST = { APPLY: 4509, CANCEL: 4510, CHANGE: 4511 };
const state = table => table.casinoBankers ||= { entries: [], history: [[], []], sequence: 0, preparedInning: 0 };
const validType = type => type === 1 || type === 2;
const legalAmount = n => Number.isSafeInteger(n) && n >= 10000 && n <= 100000000 && n % 100 === 0;
const legalPair = body => legalAmount(body.amount) && legalAmount(body.maxWinLoseAmount) && body.maxWinLoseAmount <= body.amount;
const legalCount = n => [10, 20, 30].includes(n);
const find = (table, uid, type) => state(table).entries.find(e => e.uid === uid && e.bankerType === type);
export const isActive = (table, uid) => table.playMode === 1 && state(table).entries.some(e => e.uid === Number(uid) && e.onBanker);
const cap = e => Math.max(0, Math.min(e.amount, e.maxWinLoseAmount));
const average = (table, type) => { const a = state(table).history[type - 1]; return a.length ? Math.floor(a.reduce((n, x) => n + x, 0) / a.length) : 10000000; };
function tip(io, uid, msgCode, text) { io.sendUser?.(uid, 9999, { msgCode, errorMsg: text }); }
function balance(ctx, session) {
  const m = ctx.table.members.find(m => m.uid === session.userId);
  ctx.io.sendUser?.(session.userId, 9212, session.wallet + (m?.point || 0));
}
export function list(table, totals) {
  const data = {};
  for (const [type, prefix] of [[1, 'normal'], [2, 'special']]) {
    data[prefix + 'BankerDataList'] = state(table).entries.filter(e => e.bankerType === type && !e.removed)
      .sort((a, b) => Number(b.onBanker) - Number(a.onBanker) || (b.proportion || 0) - (a.proportion || 0) || a.order - b.order)
      // The bundled readMe says no uid, but the actual findSelf consumer
      // requires uid. Running client behavior takes precedence over that note.
      .map(e => ({ uid: e.uid, name: e.name, icon: userInfoOf(e).icon, amount: e.amount, maxWinLoseAmount: e.maxWinLoseAmount,
        bankerCount: e.bankerCount, totalBankerCount: e.totalBankerCount, totalWinLoseAmount: e.totalWinLoseAmount,
        onBanker: e.onBanker, proportion: e.onBanker ? e.proportion || 0 : 0 }));
    data[prefix + 'MaxWinLoseAvg'] = average(table, type);
    data[prefix + 'TotalBet'] = totals?.[type - 1] || 0;
  }
  return data;
}
export function push(ctx, send = null) {
  if (ctx.table.playMode !== 1) return;
  (send || ((id, body) => ctx.io.broadcast(id, body)))(4561, list(ctx.table));
}
export function bind(table, session) {
  if (table.playMode !== 1) return;
  for (const e of state(table).entries.filter(e => e.uid === session.userId)) {
    e.session = session;
    // A real re-entry cancels disconnect retirement, but never an explicit down request.
    if (e.disconnected) {
      e.disconnected = false;
      if (e.disconnectCancel) e.pendingCancel = false;
      delete e.disconnectCancel;
    }
  }
}
export function request(ctx, id, body = {}) {
  if (!Object.values(REQUEST).includes(id)) return false;
  if (!body || typeof body !== 'object' || Array.isArray(body)) body = {};
  const { table, session } = ctx, uid = session.userId;
  if (table.playMode !== 1 || session.bot) { tip(ctx.io, uid, 0, '当前玩法不支持上庄'); return true; }
  const s = state(table), e = find(table, uid, body.bankerType);
  const reply = (code, msg) => ctx.send(id + 49, { code, msg });
  if (!validType(body.bankerType)) { reply(id === REQUEST.CHANGE ? 3 : 1, '上庄区域错误'); return true; }
  if (s.task || s.refunds?.length || table.closing || lifecycle.isExpired(table)) { reply(id === REQUEST.APPLY ? 8 : 1, '房间资金处理中，请稍后重试'); return true; }
  if (id === REQUEST.APPLY) {
    if (e) reply(2, '已在上庄列表中');
    else if (isActive(table, uid)) reply(7, '当前正在上庄中，无法再次申请');
    else if (s.entries.filter(e => e.bankerType === body.bankerType).length >= 10) reply(1, '当前区域庄家已满，请稍后再试');
    else if (!legalPair(body) || !legalCount(body.bankerCount ?? 10)) reply(3, '上庄金额错误 / 上庄次数设置错误');
    else if (session.wallet < body.amount) reply(4, '余额不足，无法上庄');
    else {
      const profile = userInfoOf({ uid, name: session.name, icon: session.icon });
      s.entries.push({ uid, name: profile.name, icon: profile.icon, session, bankerType: body.bankerType,
        amount: body.amount, maxWinLoseAmount: body.maxWinLoseAmount, bankerCount: body.bankerCount ?? 10,
        totalBankerCount: 0, totalWinLoseAmount: 0, onBanker: false, proportion: 0, order: ++s.sequence });
      s.preparedInning = 0;
      reply(0, '申请成功，下一局游戏开始时上庄'); push(ctx);
    }
  } else if (id === REQUEST.CANCEL) {
    if (!e) reply(1, '不在上庄列表中');
    else if (e.pendingCancel) reply(4, '已经申请下庄');
    else if (e.onBanker) { e.pendingCancel = true; reply(2, '申请成功，下一局游戏开始时下庄'); }
    else { s.entries = s.entries.filter(x => x !== e); reply(3, '申请成功'); push(ctx); }
  } else {
    const hasAmount = body.amount !== undefined || body.maxWinLoseAmount !== undefined;
    if (!e) reply(1, '不在上庄列表中');
    else if (e.pendingCancel) reply(7, '已申请下庄');
    else if (body.bankerCount !== undefined && !legalCount(body.bankerCount)) reply(2, '上庄次数设置错误');
    else if (hasAmount && !legalPair(body) || !hasAmount && body.bankerCount === undefined) reply(3, '上庄金额错误');
    else if (hasAmount && session.wallet < body.amount - (e.onBanker ? e.amount : 0)) reply(4, '余额不足，调整失败');
    else {
      const target = e.onBanker ? (e.pendingChange ||= {}) : e;
      s.preparedInning = 0;
      if (body.bankerCount !== undefined) { target.bankerCount = body.bankerCount; reply(e.onBanker ? 6 : 5, e.onBanker ? '庄家上庄次数调整完成，将在下一局开始生效' : '上庄次数调整成功'); }
      if (hasAmount) { target.amount = body.amount; target.maxWinLoseAmount = body.maxWinLoseAmount; reply(e.onBanker ? 6 : 5, e.onBanker ? '庄家金额调整完成，将在下一局开始生效' : '上庄金额调整成功'); }
    }
  }
  return true;
}
function enqueueRefund(table, entry, amount, purpose, member = null) {
  if (amount < 0 || !Number.isSafeInteger(amount)) throw new Error('Invalid banker refund');
  state(table).refunds ||= [];
  state(table).refunds.push({ entry, session: entry.session, amount, purpose, member, credited: false });
}
async function refunds(ctx) {
  const s = state(ctx.table);
  for (const r of [...(s.refunds || [])]) {
    if (!r.credited) {
      const result = await credit(r.session, r.amount, ctx);
      if (result?.ok === false) {
        if (r.purpose === 'reduce' && !r.failureNotified) {
          tip(ctx.io, r.entry.uid, 100114, '余额不足，带出失败'); r.failureNotified = true;
        }
        throw new Error('Banker cash-out rejected');
      }
      r.credited = true;
    }
    await walletOf(ctx).persist(r.session);
    s.refunds.splice(s.refunds.indexOf(r), 1);
    balance(ctx, r.session);
    if (r.amount > 0) ctx.io.sendUser?.(r.entry.uid, 3680, { uid: r.entry.uid, status: 1, carryOutAmount: r.amount, point: r.entry.amount });
    if (!r.member) features.recordCarryOut(ctx.table, { uid: r.entry.uid, name: r.entry.name, icon: r.entry.icon }, r.amount);
    if (r.member) {
      features.recordCarryOut(ctx.table, r.member, r.amount);
      ctx.table.members = ctx.table.members.filter(m => m !== r.member);
      if (!ctx.table.observers.some(m => m.uid === r.entry.uid) && !r.entry.disconnected)
        ctx.table.observers.push({ uid: r.entry.uid, name: r.entry.name, icon: r.entry.icon, point: r.session.wallet, bot: false });
      ctx.io.broadcast(3436, r.entry.uid);
    }
    if (r.purpose === 'down') s.entries = s.entries.filter(e => e !== r.entry);
  }
}
// All transfers have resident ledgers. Retrying persist never repeats credit/debit.
async function persistFunding(ctx) {
  const s = state(ctx.table);
  for (const e of s.entries) if (e.dirty) {
    await walletOf(ctx).persist(e.session);
    e.dirty = false; balance(ctx, e.session);
    if (e.carryIn > 0) ctx.io.sendUser?.(e.uid, 3230, { uid: e.uid, state: 0, carryIn: e.carryIn, carryBalance: e.amount });
    e.carryIn = 0;
  }
}
function fund(ctx, e, amount) {
  const result = debit(e.session, amount, ctx);
  if (!result.ok) {
    if (Number.isSafeInteger(result.balance) && result.balance >= 0) e.session.wallet = result.balance;
    balance(ctx, e.session);
    return false;
  }
  e.dirty = true; e.carryIn = (e.carryIn || 0) + amount;
  return true;
}
async function boundary(ctx) {
  const { table } = ctx, s = state(table);
  await refunds(ctx); await persistFunding(ctx);
  for (const e of [...s.entries]) {
    if (e.removed) continue;
    if (e.onBanker && e.pendingChange?.bankerCount !== undefined) {
      e.bankerCount = e.pendingChange.bankerCount; delete e.pendingChange.bankerCount;
    }
    if (e.pendingCancel || e.onBanker && (e.amount <= 1000 || e.totalBankerCount >= e.bankerCount)) {
      if (!e.onBanker) { s.entries = s.entries.filter(x => x !== e); continue; }
      if (!e.pendingCancel) tip(ctx.io, e.uid, e.amount <= 1000 ? 100110 : 100111, e.amount <= 1000 ? '您的上庄金额已不足，将自动下庄' : '您已经连续上庄' + e.totalBankerCount + '次，将自动下庄');
      const amount = e.amount; e.amount = 0; e.removed = true; e.onBanker = false;
      enqueueRefund(table, e, amount, 'down'); continue;
    }
    if (!e.onBanker) {
      // The previous hand has finished. Return only real seat escrow before
      // withdrawing banker capital; account money is never copied to escrow.
      const member = table.members.find(m => m.uid === e.uid);
      if (member) {
        const amount = member.point; member.point = 0;
        enqueueRefund(table, e, amount, 'seat', member); await refunds(ctx);
      }
      if (!fund(ctx, e, e.amount)) {
        tip(ctx.io, e.uid, 990101, '金币不足，无法申请上庄');
        s.entries = s.entries.filter(x => x !== e); continue;
      }
      e.onBanker = true;
      features.recordCarryIn(table, { uid: e.uid, name: e.name, icon: e.icon }, e.amount);
    } else if (e.pendingChange) {
      const change = e.pendingChange; delete e.pendingChange;
      if (change.bankerCount !== undefined) e.bankerCount = change.bankerCount;
      if (change.amount !== undefined) {
        const delta = change.amount - e.amount;
        if (delta > 0 && !fund(ctx, e, delta)) tip(ctx.io, e.uid, 100113, '余额不足，带入失败');
        else {
          e.amount = change.amount; e.maxWinLoseAmount = change.maxWinLoseAmount;
          if (delta < 0) enqueueRefund(table, e, -delta, 'reduce');
          if (delta > 0) features.recordCarryIn(table, { uid: e.uid, name: e.name, icon: e.icon }, delta);
          if (delta === 0) tip(ctx.io, e.uid, 100115, '上庄金额调整成功');
        }
      }
    }
  }
  await refunds(ctx); await persistFunding(ctx);
  s.preparedInning = table.currentInning + 1;
  push(ctx); features.pushObservers(ctx);
}
export function flush(ctx) {
  const { table } = ctx;
  if (table.playMode !== 1 || !table.casinoBankers) return;
  const s = state(table);
  if (s.task) return s.task;
  if (!s.entries.length && !s.refunds?.length) {
    s.preparedInning = table.currentInning + 1;
    return;
  }
  const atBoundary = !table.hand && table.phase === 'starting' && table.startAt <= Date.now()
    && !lifecycle.isExpired(table) && s.preparedInning !== table.currentInning + 1;
  const canRetire = !table.hand && s.entries.some(e => e.pendingCancel || lifecycle.isExpired(table));
  if (!atBoundary && !canRetire && !s.refunds?.length && !s.entries.some(e => e.dirty)) return;
  const task = (async () => {
    if (lifecycle.isExpired(table)) for (const e of s.entries) e.pendingCancel = true;
    if (atBoundary || canRetire) await boundary(ctx);
    else { await refunds(ctx); await persistFunding(ctx); }
  })();
  s.task = task;
  const clear = () => { if (s.task === task) delete s.task; };
  task.then(clear, error => { clear(); ctx.runtime?.log?.error('banker wallet persistence failed; will retry', error.message); });
  return task;
}
export function leave(ctx) {
  if (ctx.table.playMode !== 1) return;
  const s = state(ctx.table);
  for (const e of [...s.entries].filter(e => e.uid === ctx.session.userId)) {
    if (e.onBanker) {
      if (!e.pendingCancel) { e.pendingCancel = true; e.disconnectCancel = true; }
      e.disconnected = true;
    }
    else s.entries = s.entries.filter(x => x !== e);
  }
  push(ctx);
}
export function freeze(table) {
  if (table.playMode !== 1) return;
  table.hand.bankers = state(table).entries.filter(e => e.onBanker && !e.removed)
    .map(entry => ({ entry, uid: entry.uid, bankerType: entry.bankerType, cap: cap(entry), proportion: 0, score: 0 }));
}
export function ready(table) {
  return table.playMode !== 1 || !table.casinoBankers
    || (!state(table).task && !state(table).refunds?.length
      && state(table).preparedInning === table.currentInning + 1);
}
export function lock(io, table) {
  const h = table.hand;
  if (!h.bankers) return;
  // Reserve every allowed split/double outcome before any cards are revealed.
  // A player banker can never lose more than the frozen per-hand cap; the
  // system dealer retains the uncovered risk and all rounding remainder.
  const main = h.players.reduce((n, p) => n + p.mainBet, 0);
  h.bankerTotals = [main, 0];
  h.bankerExposure = [main * 6, main];
  for (const type of [1, 2]) {
    const group = h.bankers.filter(b => b.bankerType === type);
    const denominator = Math.max(h.bankerExposure[type - 1], group.reduce((n, b) => n + b.cap, 0));
    for (const b of group) { b.denominator = denominator; b.proportion = denominator ? b.cap / denominator * 100 : 0; b.entry.proportion = Math.floor(b.proportion * 100) / 100; }
  }
  io.broadcast(4561, list(table, h.bankerTotals));
}
export function settle(table, results) {
  const h = table.hand;
  if (!h.bankers || h.bankerSettled) return [];
  h.bankerSettled = true;
  const nets = [-results.reduce((n, r) => n + r.gameScore, 0), -h.players.reduce((n, p) => n + p.insuranceProfit, 0)];
  h.bankerTotals[1] = h.players.reduce((n, p) => n + p.insuranceAmount, 0);
  const byUid = new Map();
  for (const b of h.bankers) {
    const net = nets[b.bankerType - 1];
    b.score = b.denominator ? Number(BigInt(net) * BigInt(b.cap) / BigInt(b.denominator)) : 0;
    if (Math.abs(b.score) > b.cap || b.entry.amount + b.score < 0) throw new Error('Banker exposure exceeded');
    b.entry.amount += b.score; b.entry.totalWinLoseAmount += b.score; b.entry.totalBankerCount++;
    table.houseNetScore -= b.score;
    let result = byUid.get(b.uid);
    if (!result) { result = { uid: b.uid, name: b.entry.name, icon: b.entry.icon, score: 0, take: 0, areas: [], xiaZhuData: 0 }; byUid.set(b.uid, result); }
    result.score += b.score;
    result.areas.push({ bankerType: b.bankerType, score: b.score, proportion: b.entry.proportion, take: 0 });
  }
  for (const [i, samples] of state(table).history.entries()) { samples.push(h.bankerExposure[i]); if (samples.length > 10) samples.shift(); }
  const stats = [...byUid.values()];
  return stats;
}
