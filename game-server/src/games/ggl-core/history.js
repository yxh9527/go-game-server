import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { getCachedRecords } = await rel(import.meta.url, '../../record-cache.js', v);
const { prizeFromMask } = await rel(import.meta.url, './rules.js', v);
function parse(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
export function decodeRecord(row, table, uid) {
  if (Number(row?.userId) !== uid || Number(row?.agentId) !== Number(table.agentId || 0) || Number(row?.gameId) !== Number(table.roomType)) return null;
  const values = [parse(row.init), ...(Array.isArray(row.log) ? row.log.map(log => parse(log.sr)) : [])];
  const record = values.find(data => data && Number(data.roomId) === table.roomId && Number(data.gameRoomId) === table.gameRoomId
    && typeof data.serialNo === 'string' && Number.isSafeInteger(data.faceValue) && table.config.denominations.includes(data.faceValue));
  if (!record) return null;
  try {
    const prize = prizeFromMask(record.huMask, table.config.winMultipliers);
    if (prize.huCount !== record.huCount || prize.multiplier !== record.multiplier || record.amount !== record.faceValue * (prize.multiplier - 1)) return null;
    return { serialNo: record.serialNo, faceValue: record.faceValue, huMask: record.huMask.slice(), ...prize,
      roomType: table.roomType, amount: record.amount };
  } catch { return null; }
}
export async function list(ctx) {
  const { table, session } = ctx, uid = Number(session.userId);
  table.scratchHistoryTasks ||= new Map();
  if (table.scratchHistoryTasks.has(uid)) return table.scratchHistoryTasks.get(uid);
  const task = query(ctx).finally(() => table.scratchHistoryTasks.delete(uid));
  table.scratchHistoryTasks.set(uid, task);
  return task;
}
async function query(ctx) {
  const { table, session, runtime } = ctx, uid = Number(session.userId), endTime = Math.ceil(Date.now() / 30000) * 30000;
  const prefix = 'scratch:' + Number(table.agentId || 0) + ':' + table.roomType + ':' + table.roomId + ':';
  const bus = { getCache: key => runtime.rpc.bus.getCache(prefix + key), setCache: (key, value, ttl) => runtime.rpc.bus.setCache(prefix + key, value, ttl) };
  const response = await getCachedRecords({ gateway: runtime.rpc.gateway, bus, userId: uid,
    query: { gameId: table.roomType, page: 1, size: 100, startTime: endTime - 8 * 3600000, endTime }, ttlSeconds: 30 });
  const seen = new Set(), winInfo = [];
  for (const row of response?.data || []) {
    const data = decodeRecord(row, table, uid);
    if (data && !seen.has(data.serialNo)) { seen.add(data.serialNo); winInfo.push(data); }
  }
  // data-center returns newest first; native panels open index length - 1.
  return { gameRoomId: table.gameRoomId, winInfo: winInfo.reverse() };
}
