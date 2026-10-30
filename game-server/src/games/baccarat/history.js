import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const local = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/hundred-history.js', v) : null;
const { getCachedRecords, getCachedRecordDetail } = await rel(import.meta.url, '../../record-cache.js', v);

export function record(table, result, viewers, io = {}) {
  if (io.env === 'prod') return;
  const extras = new Map();
  for (const [uid, data] of result.bankerSettlements || []) extras.set(uid, {
    bankerInningData: { bankerTotalWinLoseMap: result.bankerTotalWinLoseMap,
      bankerAreaTotalBet: { 1: data.normalTotalBet, 2: data.specialTotalBet },
      bankerInningInfoMap: { [uid]: { dataMap: Object.fromEntries(data.areas.map(a => [a.bankerType,
        { score: a.score, proportion: a.proportion }])) } } } });
  local?.record(table, { showdownPokers: { other: result.player, banker: result.banker },
    showdownTypes: { other: result.p, banker: result.b }, winAreaIds: result.areas.slice() }, viewers, result.settlements, extras);
}

function parse(text) { try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; } }
function decodeRecord(row, table, uid) {
  if (Number(row?.userId) !== uid || Number(row?.agentId) !== Number(table.agentId || 0)
    || Number(row?.gameId) !== 58) return null;
  const values = [parse(row.init), ...(Array.isArray(row.log) ? row.log : []).map(log => parse(log.sr))];
  return values.find(data => data && Number(data.gameRoomId ?? data.roomId) === Number(table.roomId)
    && Number.isSafeInteger(data.currInning) && data.currInning > 0
    && Array.isArray(data.showdownPokers?.other) && Array.isArray(data.showdownPokers?.banker)
    && data.showdownTypes && Array.isArray(data.winAreaIds) && data.betDetailTableMap) || null;
}

function busFor(ctx) {
  const bus = ctx.runtime.rpc.bus, prefix = 'baccarat:' + Number(ctx.table.agentId || 0) + ':' + ctx.table.roomId + ':';
  return { getCache: key => bus.getCache(prefix + key), setCache: (key, value, ttl) => bus.setCache(prefix + key, value, ttl) };
}

export async function list(ctx) {
  const { table, session } = ctx, uid = Number(session.userId);
  if (local && ctx.runtime?.env !== 'prod') return local.list(table, uid);
  const known = table.baccaratRecordRefs?.get(uid);
  if (known?.expiresAt > Date.now()) return { gameRoomId: table.roomId, list: [...known.refs.keys()].sort((a,b) => a-b) };
  table.baccaratRecordListTasks ||= new Map();
  if (table.baccaratRecordListTasks.has(uid)) return table.baccaratRecordListTasks.get(uid);
  const task = queryList(ctx).finally(() => table.baccaratRecordListTasks.delete(uid));
  table.baccaratRecordListTasks.set(uid, task);
  return task;
}

async function queryList(ctx) {
  const { table, session } = ctx, uid = Number(session.userId);
  const endTime = Math.ceil(Date.now() / 30000) * 30000;
  const response = await getCachedRecords({ gateway: ctx.runtime.rpc.gateway, bus: busFor(ctx), userId: uid,
    query: { gameId: 58, page: 1, size: 100, startTime: endTime - 8 * 3600000, endTime }, ttlSeconds: 30 });
  const refs = new Map();
  for (const row of response?.data || []) {
    const detail = decodeRecord(row, table, uid);
    if (detail && (row.hash || row.roundID)) refs.set(detail.currInning, row.hash || row.roundID);
  }
  table.baccaratRecordRefs ||= new Map();
  for (const [id, value] of table.baccaratRecordRefs) if (value.expiresAt <= Date.now()) table.baccaratRecordRefs.delete(id);
  if (table.baccaratRecordRefs.size >= 1000) table.baccaratRecordRefs.delete(table.baccaratRecordRefs.keys().next().value);
  table.baccaratRecordRefs.set(uid, { refs, expiresAt: Date.now() + 30000 });
  return { gameRoomId: table.roomId, list: [...refs.keys()].sort((a, b) => a - b) };
}

export async function detail(ctx, inning) {
  const { table, session } = ctx, uid = Number(session.userId);
  if (!Number.isSafeInteger(inning) || inning <= 0) return null;
  if (local && ctx.runtime?.env !== 'prod') return local.detail(table, uid, inning);
  if (!table.baccaratRecordRefs?.get(uid) || table.baccaratRecordRefs.get(uid).expiresAt <= Date.now()) await list(ctx);
  const recordId = table.baccaratRecordRefs.get(uid)?.refs.get(inning);
  if (!recordId) return null;
  table.baccaratRecordDetailTasks ||= new Map();
  const key = uid + ':' + inning;
  if (table.baccaratRecordDetailTasks.has(key)) return table.baccaratRecordDetailTasks.get(key);
  const task = queryDetail(ctx, recordId, inning).finally(() => table.baccaratRecordDetailTasks.delete(key));
  table.baccaratRecordDetailTasks.set(key, task);
  return task;
}

async function queryDetail(ctx, recordId, inning) {
  const { table, session } = ctx, uid = Number(session.userId);
  const response = await getCachedRecordDetail({ gateway: ctx.runtime.rpc.gateway, bus: busFor(ctx), userId: uid,
    gameId: 58, recordId, ttlSeconds: 300 });
  const data = response?.found ? decodeRecord(response.data, table, uid) : null;
  return data?.currInning === inning ? data : null;
}
