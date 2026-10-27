import { debit, walletOf } from '../../wallet/index.js';

// Native LiveBlackJack uses five fixed display seats, without Bjk rotation.
// Keep storage positions contiguous for the shared seat/robot/lifecycle code.
export const DISPLAY_SEATS = Object.freeze([1, 2, 3, 5, 6]);
export const isCasino = table => table.playMode === 1;
export const displaySeat = pos => DISPLAY_SEATS[pos] ?? -1;
// Unlike ordinary Bjk, the native casino has no CARRYIN_RESULT listener or
// carry request. A seat uses its account's available money; only accepted
// wagers enter the shared table escrow. Never transfer the whole wallet.
export const availablePoint = member => (member?.point || 0) + (member?.casinoWalletSession?.wallet || 0);
export function bindWalletSeat(member, session) {
  if (!member || member.bot || session.bot) return;
  member.casinoWalletSession = session;
  delete member.carryDeadline;
  member.carryLeftTime = 0;
}
export function fundWager(io, table, member, amount) {
  const session = member.casinoWalletSession;
  if (!session) return false;
  const result = debit(session, amount, io);
  if (!result.ok) {
    if (Number.isSafeInteger(result.balance) && result.balance >= 0) session.wallet = result.balance;
    return false;
  }
  table.casinoWalletDirty ||= new Map();
  const previous = table.casinoWalletDirty.get(member.uid);
  table.casinoWalletDirty.set(member.uid, { session, revision: (previous?.revision || 0) + 1 });
  return true;
}
export function flushWalletFunding(ctx) {
  const { table } = ctx;
  if (table.casinoWalletTask) return table.casinoWalletTask;
  if (!table.casinoWalletDirty?.size) return;
  const task = (async () => {
    for (const [uid, entry] of [...table.casinoWalletDirty]) {
      await walletOf(ctx).persist(entry.session);
      if (table.casinoWalletDirty.get(uid) === entry) table.casinoWalletDirty.delete(uid);
    }
  })();
  table.casinoWalletTask = task;
  const clear = () => { if (table.casinoWalletTask === task) delete table.casinoWalletTask; };
  task.then(clear, error => {
    clear();
    ctx.runtime?.log?.error('casino wager persistence failed; will retry', error.message);
  });
  return task;
}
export function nativeState(table, state, uid = 0) {
  if (!isCasino(table)) return state;
  const seat = row => ({ ...row, displaySeat: displaySeat(row.pos),
    // The original client displays mainBet + betAmount as the seat total.
    // All accepted own-seat wagers are in betAmount; no edge stake is added.
    mainBet: 0, myAnteBet: row.uid === Number(uid) ? row.betAmount || 0 : 0,
    myEdgeBet: 0, myPairBet: 0, myNotPairBet: 0, myPairOdds: 0, myNotPairOdds: 0,
    winStreak: table.members.find(m => m.uid === row.uid)?.winStreak || 0 });
  const active = state.players?.find(p => p.uid === state.currentActionPlayerId);
  const self = state.players?.find(p => p.uid === Number(uid));
  return { ...state, stateStart: table.hand?.stateStart || 0, sideBets: {},
    sideBetLimit: { pairMaxBet: 0, notPairMaxBet: 0 },
    players: (state.players || []).map(seat),
    actionList: (state.actionList || []).map(row => ({ ...row, displaySeat: displaySeat(row.pos) })),
    selfAvailableActions: self?.availableActions || [],
    currentActionDisplaySeat: active ? displaySeat(active.pos) : -1,
    ...(state.settleList ? { settleList: state.settleList.map(seat) } : {}) };
}
export function betResponse(io, table, uid, body, code, wallet) {
  if (!isCasino(table)) return;
  const member = table.members.find(m => m.uid === Number(uid));
  // The native client applies point even on rejection. Observers have no
  // carried member balance; use their actual wallet, never a synthetic zero.
  const point = member ? availablePoint(member) : wallet ?? io.sessionFor?.(Number(uid))?.wallet;
  io.sendUser?.(Number(uid), 4556, { code, ...(point !== undefined ? { point } : {}),
    targetDisplaySeat: body.targetPos ?? (member ? displaySeat(member.pos) : -1),
    betAmount: code === 200 ? body.betAmount : 0, pairAmount: 0, notPairAmount: 0 });
}
export function seatBetUpdate(io, table, snapshot) {
  if (!isCasino(table)) return;
  const send = uid => {
    for (const row of nativeState(table, snapshot, uid).players) io.sendUser?.(uid, 4557, row);
  };
  io.forEachPlayer?.(session => send(session.userId));
}
