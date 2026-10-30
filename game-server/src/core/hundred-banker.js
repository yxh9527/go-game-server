import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { debit, credit, walletOf } = await rel(import.meta.url, '../wallet/index.js', v);
const { userInfoOf } = await rel(import.meta.url, './member.js', v);

export const REQUESTS = [6133, 6134, 6135];
const state = table => table.hundredBankers ||= { entries: [], refunds: [], history: [[], []], order: 0 };
const validAmount = n => Number.isSafeInteger(n) && n >= 10000 && n <= 100000000 && n % 100 === 0;
const validPair = body => validAmount(body.amount) && validAmount(body.maxWinLoseAmount) && body.maxWinLoseAmount <= body.amount;
const active = table => state(table).entries.filter(e => e.onBanker && !e.removed);
export const isBanker = (table, uid) => active(table).some(e => e.uid === Number(uid));
function tip(io, uid, text) { io.sendUser?.(uid, 9999, { msgCode: 0, errorMsg: text }); }
export function bind(table, session) {
  for (const e of state(table).entries) if (e.uid === Number(session.userId)) {
    e.session = session;
    if (e.disconnectCancel) { e.pendingCancel = false; e.disconnectCancel = false; }
  }
}
export function list(table, groups) {
  const s = state(table), data = {};
  for (const [type, name] of [[1, 'normal'], [2, 'special']]) {
    const h = s.history[type - 1];
    data[name + 'MaxWinLoseAvg'] = h.length ? Math.floor(h.reduce((n, v) => n + v, 0) / h.length) : 10000000;
    data[name + 'TotalBet'] = (table.totalBetsByArea || []).filter(b => groups[type - 1].includes(b.areaId)).reduce((sum, b) => sum + b.total, 0);
    data[name + 'BankerDataList'] = s.entries.filter(e => e.bankerType === type && !e.removed)
      .sort((a, b) => Number(b.onBanker) - Number(a.onBanker) || (b.proportion || 0) - (a.proportion || 0) || a.order - b.order)
      .map(e => ({ uid: e.uid, name: e.name, icon: e.icon, amount: e.amount, maxWinLoseAmount: e.maxWinLoseAmount,
        bankerCount: e.bankerCount, totalBankerCount: e.totalBankerCount, totalWinLoseAmount: e.totalWinLoseAmount,
        onBanker: e.onBanker, proportion: e.onBanker ? e.proportion || 0 : 0 }));
  }
  return data;
}
export function push(io, table, groups) { io.broadcast(6243, list(table, groups)); }

export function request(ctx, id, body, groups, enabled = true) {
  if (!REQUESTS.includes(id)) return false;
  const { table, session, send, io } = ctx, uid = Number(session.userId), s = state(table);
  const reply = (code, msg) => send(id + 107, { code, msg });
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.roomId != null && Number(body.roomId) !== Number(table.roomId)) { reply(1, '上庄请求无效'); return true; }
  if (!enabled || session.bot) { reply(1, '当前房间不支持上庄'); return true; }
  if (![1, 2].includes(body.bankerType)) { reply(1, '上庄区域无效'); return true; }
  if (s.task || s.refunds.length) { reply(1, '资金处理中，请稍后重试'); return true; }
  const e = s.entries.find(e => e.uid === uid && e.bankerType === body.bankerType);
  if (id === 6133) {
    if (e) reply(1, '请勿重复申请上庄');
    else if (!validPair(body) || session.wallet < body.amount) reply(1, '上庄金额无效或余额不足');
    else if (s.entries.filter(e => e.bankerType === body.bankerType && !e.removed).length >= 10) reply(1, '当前区域庄家已满');
    else {
      const info = userInfoOf({ ...session, uid });
      s.entries.push({ uid, name: info.name, icon: info.icon, session, bankerType: body.bankerType,
        amount: body.amount, maxWinLoseAmount: body.maxWinLoseAmount, bankerCount: 10,
        totalBankerCount: 0, totalWinLoseAmount: 0, onBanker: false, order: ++s.order });
      reply(0, '申请上庄成功，将在下一局开始时生效');
    }
  } else if (id === 6134) {
    if (!e || e.removed) reply(1, '当前没有上庄申请');
    else if (e.pendingCancel) reply(4, '已申请下庄');
    else if (e.onBanker) { e.pendingCancel = true; reply(2, '将在本局结束后下庄'); }
    else { s.entries.splice(s.entries.indexOf(e), 1); reply(3, '已取消上庄申请'); }
  } else {
    const hasAmount = body.amount !== undefined || body.maxWinLoseAmount !== undefined;
    if (!e || e.removed || e.pendingCancel) reply(3, '当前无法调整上庄数据');
    else if (hasAmount && !validPair(body) || body.bankerCount !== undefined && ![10, 20, 30].includes(body.bankerCount)) reply(3, '上庄参数无效');
    else if (hasAmount && session.wallet < body.amount - (e.onBanker ? e.amount : 0)) reply(4, '余额不足');
    else {
      const target = e.onBanker ? e.pendingChange ||= {} : e;
      if (hasAmount) { target.amount = body.amount; target.maxWinLoseAmount = body.maxWinLoseAmount; }
      if (body.bankerCount !== undefined) target.bankerCount = body.bankerCount;
      reply(e.onBanker ? 6 : 5, e.onBanker ? '修改将在下一局生效' : '上庄数据修改成功');
    }
  }
  push(io, table, groups); return true;
}

function refund(s, e, amount, remove) { s.refunds.push({ e, amount, remove, credited: false }); }
async function flushRefunds(ctx) {
  const s = state(ctx.table);
  for (const r of [...s.refunds]) {
    if (!r.credited) {
      const receipt = r.amount > 0 ? await credit(r.e.session, r.amount, ctx) : { ok: true };
      if (receipt?.ok === false) throw new Error('Hundred banker refund rejected');
      r.credited = true;
    }
    await walletOf(ctx).persist?.(r.e.session);
    ctx.io.sendUser?.(r.e.uid, 3680, { uid: r.e.uid, status: 1, carryOutAmount: r.amount, point: r.e.amount });
    ctx.io.sendUser?.(r.e.uid, 6210, { points: r.e.session.wallet });
    if (r.remove && s.entries.includes(r.e)) s.entries.splice(s.entries.indexOf(r.e), 1);
    s.refunds.splice(s.refunds.indexOf(r), 1);
  }
}
export function boundary(ctx, groups) {
  const { table, io } = ctx, s = state(table);
  if (s.task) return s.task;
  if (s.preparedInning === table.inning && !s.refunds.length) return;
  if (!s.entries.length && !s.refunds.length) { s.preparedInning = table.inning; return; }
  const task = (async () => {
    await flushRefunds(ctx);
    for (const e of [...s.entries]) {
      if (e.dirty) { await walletOf(ctx).persist?.(e.session); e.dirty = false; }
      if (e.removed) continue;
      if (e.pendingCancel || e.onBanker && (e.amount < 10000 || e.totalBankerCount >= (e.pendingChange?.bankerCount ?? e.bankerCount))) {
        if (e.onBanker) { const amount = e.amount; e.amount = 0; e.onBanker = false; e.removed = true; refund(s, e, amount, true); }
        else s.entries.splice(s.entries.indexOf(e), 1);
        continue;
      }
      const next = e.pendingChange || e, target = next.amount ?? e.amount;
      const delta = target - (e.onBanker ? e.amount : 0);
      if (delta > 0 && !debit(e.session, delta, ctx).ok) {
        tip(io, e.uid, '余额不足，上庄带入失败');
        if (!e.onBanker) s.entries.splice(s.entries.indexOf(e), 1);
        delete e.pendingChange; continue;
      }
      if (delta > 0) e.dirty = true;
      if (delta < 0) refund(s, e, -delta, false);
      e.amount = target; e.maxWinLoseAmount = next.maxWinLoseAmount ?? e.maxWinLoseAmount;
      e.bankerCount = next.bankerCount ?? e.bankerCount; e.onBanker = true; delete e.pendingChange;
      if (e.dirty) {
        await walletOf(ctx).persist?.(e.session); e.dirty = false;
        io.sendUser?.(e.uid, 3230, { uid: e.uid, state: 0, carryIn: delta, carryBalance: e.amount });
        io.sendUser?.(e.uid, 6210, { points: e.session.wallet });
      }
    }
    await flushRefunds(ctx); s.preparedInning = table.inning; push(io, table, groups);
  })();
  s.task = task;
  task.then(() => { if (s.task === task) s.task = null; }, () => { if (s.task === task) s.task = null; });
  return task;
}

export function lock(table, hand, groups, prices) {
  if (hand.bankers) return;
  const entries = active(table), totals = table.totalBetsByArea || [];
  hand.bankers = [];
  hand.bankerExposure = groups.map(ids => {
    const bets = totals.filter(b => ids.includes(b.areaId));
    const win = bets.reduce((sum, bet) => sum + bet.total, 0);
    const lose = bets.reduce((sum, bet) => sum + Math.ceil(bet.total * Math.max(...prices[bet.areaId].oddsList) / 100), 0);
    return Math.max(win, lose);
  });
  for (const [i] of groups.entries()) {
    const bankers = entries.filter(e => e.bankerType === i + 1);
    const denominator = Math.max(hand.bankerExposure[i], bankers.reduce((sum, e) => sum + Math.min(e.amount, e.maxWinLoseAmount), 0));
    for (const e of bankers) {
      const cap = Math.min(e.amount, e.maxWinLoseAmount);
      e.proportion = denominator ? Math.floor(cap / denominator * 10000) / 100 : 0;
      hand.bankers.push({ entry: e, cap, denominator, bankerType: i + 1 });
    }
  }
}
export function settle(io, table, result, groups) {
  if (result.bankersSettled) return;
  const hand = table.preparedHand;
  if (!hand?.bankers) return;
  const nets = groups.map(ids => -[...result.settlements.values()].reduce((sum, p) => sum
    + ids.reduce((n, id) => n + (p.areaWinningScores[id] || 0), 0), 0));
  const byUid = new Map();
  // Validate the entire allocation before changing any escrow balance. A failed
  // validation must leave every banker unchanged so a retry cannot double-pay.
  const payments = hand.bankers.map(b => {
    const net = nets[b.bankerType - 1];
    if (!Number.isSafeInteger(net) || !Number.isSafeInteger(b.cap) || !Number.isSafeInteger(b.denominator)) throw new Error('Invalid hundred banker exposure');
    const score = b.denominator ? Number(BigInt(net) * BigInt(b.cap) / BigInt(b.denominator)) : 0;
    if (Math.abs(score) > b.cap || b.entry.amount + score < 0
      || !Number.isSafeInteger(b.entry.amount + score) || !Number.isSafeInteger(b.entry.totalWinLoseAmount + score)) throw new Error('Hundred banker exposure exceeded');
    return { b, score };
  });
  for (const { b, score } of payments) {
    b.entry.amount += score; b.entry.totalBankerCount++; b.entry.totalWinLoseAmount += score;
    const data = byUid.get(b.entry.uid) || { score: 0, areas: [], normalTotalBet: 0, specialTotalBet: 0, normalProportion: 0, specialProportion: 0 };
    data.score += score; data.areas.push({ bankerType: b.bankerType, score, proportion: b.entry.proportion });
    const prefix = b.bankerType === 1 ? 'normal' : 'special';
    data[prefix + 'Proportion'] = b.entry.proportion;
    data[prefix + 'TotalBet'] = list(table, groups)[prefix + 'TotalBet']; byUid.set(b.entry.uid, data);
  }
  for (const [i, exposure] of hand.bankerExposure.entries()) {
    state(table).history[i].push(exposure); if (state(table).history[i].length > 10) state(table).history[i].shift();
  }
  result.bankersSettled = true;
  result.bankerSettlements = byUid;
  result.bankerTotalWinLoseMap = { 1: nets[0], 2: nets[1] };
  for (const [uid, data] of byUid) io.sendUser?.(uid, 6244, data);
  push(io, table, groups);
}
export function leave(table, session) {
  const s = state(table);
  for (const e of [...s.entries].filter(e => e.uid === Number(session.userId))) {
    if (e.removed || s.refunds.some(r => r.e === e)) continue;
    if (!e.onBanker) s.entries.splice(s.entries.indexOf(e), 1);
    else if (!e.pendingCancel) { e.pendingCancel = true; e.disconnectCancel = true; }
  }
}
