import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { ERROR, kindOf, prizeFromMask } = await rel(import.meta.url, './rules.js', v);
const local = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/scratch-tickets.js', v) : null;
const history = await rel(import.meta.url, './history.js', v);
export { prizeFromMask };

export function createScratchTable(roomId, roomType, roomRow, config) {
  return { gameId: config.id, kind: config.kind, roomId: Number(roomId), roomType: Number(roomType) || config.roomTypes[0],
    cfg: roomRow || {}, config, gameRoomId: Number(roomId) + 1000000,
    roomIndex: Number(roomRow?.room_index ?? config.defaultRoomIndex ?? 0) };
}
export function scratchConf(table) {
  const cfg = table.config;
  return { roomType: cfg.confRoomType, playMode: 0,
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
    gglParams: { gameName: cfg.gameName, title: cfg.title,
      gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
      maxBet: Number(table.cfg?.hundred_max_bet || cfg.defaultMaxBet), roomIndex: table.roomIndex } };
}
function service(ctx) {
  if (ctx.runtime?.scratchTickets) return ctx.runtime.scratchTickets;
  if (local && ctx.runtime?.env !== 'prod') {
    // Resident owner preserves inventory and wallet tasks across hot replacement.
    const owner = ctx.runtime || ctx.table;
    return local.createScratchTickets({ resident: owner.scratchTicketState ||= {} });
  }
  throw Object.assign(new Error('Production scratch ticket service is not configured'), { code: ERROR.STORAGE });
}
function base(table, session) {
  return { code: 0, roomId: table.roomId, gameRoomId: table.gameRoomId,
    roomTypeCode: table.roomType, walletAmount: Number(session.wallet) };
}
export async function scratchRequest(ctx, method, body = {}) {
  const { table, session } = ctx;
  body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  try {
    if (body.kind !== undefined && body.kind !== kindOf(table)) throw Object.assign(new Error('Wrong ticket kind'), { code: ERROR.INVALID });
    const result = await service(ctx)[method](ctx, body);
    if (!result || typeof result !== 'object' || !Number.isInteger(result.code)) throw new Error('Scratch service returned no valid result');
    return { ...base(table, session), ...result };
  } catch (err) {
    ctx.runtime?.log?.error?.('scratch ' + method + ' failed', err?.message || String(err));
    return { ...base(table, session), code: Object.values(ERROR).includes(err?.code) ? err.code : ERROR.STORAGE,
      pendingTickets: [], denominations: table.config.denominations.slice(), winMultipliers: table.config.winMultipliers.slice(),
      accumulatedWin: 0, accumulatedWinByKind: { GGL1: 0, GGL2: 0 },
      newTickets: [], failedItems: [], matchedSerials: [], searchType: body.searchType, purchaseMode: body.purchaseMode };
  }
}
export function scratchState(table, session, ctx = {}) { return scratchRequest({ ...ctx, table, session }, 'state'); }
export function buyTicket(table, session, body, ctx = {}) { return scratchRequest({ ...ctx, table, session }, 'reveal', body); }
export async function scratchHistory(ctx) {
  if (local && ctx.runtime?.env !== 'prod') return { gameRoomId: ctx.table.gameRoomId, winInfo: await service(ctx).history(ctx) };
  return history.list(ctx);
}
