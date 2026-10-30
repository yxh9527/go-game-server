const OWNER_MIN_BALANCE = 50000; // Original hall: balance >= 500 CNY, protocol cents.
export const REQUESTS = [6129, 6130, 6131, 6132];
const isVip = table => Number(table.playMode ?? table.cfg?.play_mode) === 4;
const isOwner = (table, session) => table.baccaratOwner?.uid === Number(session.userId);

function settings(table) {
  table.baccaratOwnerSettings ||= { betTime: 20, peekTime: 10, dealer: 223, bg: 1, ...table.config?.ownerDefaults };
  return table.baccaratOwnerSettings;
}
export function privilege(table) {
  const current = settings(table), next = table.baccaratOwnerPending || {};
  return { ...current, ...next, activeBetTime: current.betTime, activePeekTime: current.peekTime,
    activeDealer: current.dealer, activeBg: current.bg,
    remainShuffleCount: Math.max(0, (table.config?.ownerShuffleAfterHands ?? 30) - (table.shoeHands || 0)),
    remainDealerBgTime: Math.max(0, Math.ceil(((table.baccaratOwner?.appearanceAt || 0)
      + (table.config?.ownerAppearanceCooldownSeconds ?? 600) * 1000 - Date.now()) / 1000)) };
}
export function betAreas(table) {
  const bets = table.playerBets.get(table.baccaratOwner?.uid) || [];
  return bets.filter(b => [1, 2].includes(b.areaId) && b.total > 0).map(b => b.areaId);
}
export function snapshot(table) {
  const owner = table.baccaratOwner;
  return { hostUid: owner?.uid || 0, hostName: owner?.name || '',
    hostActive: Boolean(owner && betAreas(table).length), hostBetAreas: betAreas(table), hostPrivilege: privilege(table) };
}
function push(io, table) { io.broadcast(6236, snapshot(table)); }
function error(ctx, text) { ctx.send(9999, { msgCode: 0, errorMsg: text }); }

export function enter(ctx, body) {
  const { table, session } = ctx;
  if (!isVip(table) || !body || body.backgroundEnter || session.bot) return;
  const mode = Number(body.vipTableMode);
  if (table.baccaratOwner?.uid === Number(session.userId)) { table.baccaratOwner.releasePending = false; return; }
  if (mode !== 0) return; // vipTableMode=1 is the original ordinary/observer entry.
  if (table.baccaratOwner) { error(ctx, '当前房间已有桌主'); return; }
  if (!Number.isSafeInteger(session.wallet) || session.wallet < Number(table.cfg?.vip_min_balance ?? OWNER_MIN_BALANCE)) { error(ctx, '余额不足，无法成为桌主'); return; }
  table.baccaratOwner = { uid: Number(session.userId), name: session.name || '玩家' + session.userId,
    appearanceAt: Date.now(), claimedAt: Date.now(), releasePending: false };
  settings(table); push(ctx.io, table);
}
export function canBet(table, session) { return table.config?.ownerOnlyBet === false || !isVip(table) || !table.baccaratOwner || isOwner(table, session); }
export function afterBet(ctx) { if (isVip(ctx.table)) push(ctx.io, ctx.table); }
export function beforeRound(io, table) {
  if (!isVip(table)) return;
  if (table.baccaratOwner?.releasePending) { table.baccaratOwner = null; push(io, table); }
  if (table.baccaratOwnerPending) {
    Object.assign(settings(table), table.baccaratOwnerPending); delete table.baccaratOwnerPending;
    io.broadcast(6234, privilege(table));
  }
}
export function leave(ctx) {
  if (!isVip(ctx.table) || !isOwner(ctx.table, ctx.session)) return;
  if (ctx.table.playerBets.get(Number(ctx.session.userId))?.length && !ctx.table.lastResult?.settled) ctx.table.baccaratOwner.releasePending = true;
  else { ctx.table.baccaratOwner = null; push(ctx.io, ctx.table); }
}
export function handle(ctx, id, body) {
  if (!REQUESTS.includes(id)) return false;
  const { table, session, send, io } = ctx;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || body.roomId != null && Number(body.roomId) !== Number(table.roomId)) { error(ctx, '桌主请求无效'); return true; }
  if (id === 6129) { send(6233, privilege(table)); return true; }
  if (!isVip(table) || !isOwner(table, session)) { error(ctx, '只有本桌桌主可以进行此操作'); return true; }
  if (id === 6130) {
    const pending = {};
    if (body.betTime !== undefined) {
      if (![10, 15, 20, 30].includes(body.betTime)) { error(ctx, '下注时间无效'); return true; }
      pending.betTime = body.betTime;
    }
    if (body.peekTime !== undefined) {
      if (![-1, 5, 10, 15].includes(body.peekTime)) { error(ctx, '咪牌时间无效'); return true; }
      pending.peekTime = body.peekTime;
    }
    if (body.newShoe) {
      if (privilege(table).remainShuffleCount > 0) { error(ctx, '当前牌靴尚未达到更换条件'); return true; }
    }
    if (body.dealer !== undefined || body.bg !== undefined) {
      if (privilege(table).remainDealerBgTime > 0) { error(ctx, '包桌满10分钟后才能更换荷官和背景'); return true; }
      if (body.dealer !== undefined) {
        const n = body.dealer;
        const ranges = table.config?.ownerAppearance?.dealerRanges || [[1, 30], [101, 130], [201, 232]];
        if (!Number.isInteger(n) || !ranges.some(([min, max]) => n >= min && n <= max)) { error(ctx, '荷官无效'); return true; }
        pending.dealer = n;
      }
      if (body.bg !== undefined) {
        const [min, max] = table.config?.ownerAppearance?.bgRange || [1, 18];
        if (!Number.isInteger(body.bg) || body.bg < min || body.bg > max) { error(ctx, '桌面背景无效'); return true; }
        pending.bg = body.bg;
      }
    }
    if (body.newShoe) table.shuffleRequested = true;
    if (body.dealer !== undefined || body.bg !== undefined) table.baccaratOwner.appearanceAt = Date.now();
    Object.assign(table.baccaratOwnerPending ||= {}, pending);
    io.broadcast(6234, privilege(table)); return true;
  }
  if (id === 6131) {
    if (table.state !== 2 || Date.now() >= table.phaseEndsAt) { send(6235, { code: 1 }); return true; }
    const hasBets = [...table.playerBets.values()].some(b => b.length);
    if (hasBets && !betAreas(table).length && !table.config?.ownerCanFlyWithBets) { send(6235, { code: 1 }); return true; }
    table.baccaratFlying = !hasBets;
    table.phaseEndsAt = Date.now(); send(6235, { code: 0 }); return true;
  }
  if (![4, 9].includes(table.state) || !snapshot(table).hostActive) { send(6238, { code: 1 }); return true; }
  const key = table.inning + ':' + table.hundredPhaseIndex;
  if (table.baccaratOwnerPeekFinished !== key) {
    table.baccaratOwnerPeekFinished = key;
    table.phaseEndsAt = Math.min(table.phaseEndsAt, Date.now() + 1500);
  }
  send(6238, { code: 0 }); return true;
}
