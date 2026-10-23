const DEFAULT_TTL_SECONDS = 300;
const MAX_PAGE = 100;

export async function getCachedRecords({ gateway, bus, userId, query, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const uid = Number(userId) || 0;
  if (!uid) throw new Error("userId is required");
  const page = Math.min(MAX_PAGE, Math.max(1, Number(query?.page) || 1));
  const size = Math.min(MAX_PAGE, Math.max(1, Number(query?.size) || 20));
  const normalized = {
    ...query,
    userId: uid,
    page,
    size,
    gameId: Number(query?.gameId) || 0,
    startTime: Math.max(0, Number(query?.startTime) || 0),
    endTime: Math.max(0, Number(query?.endTime) || 0),
  };
  const key = `game-records:v1:${uid}:${normalized.gameId}:${page}:${size}:${normalized.startTime}:${normalized.endTime}:${String(normalized.symbol || "")}:${String(normalized.hash || "")}:${String(normalized.currency || "")}`;
  const cached = await bus.getCache(key);
  if (cached != null) {
    try {
      return JSON.parse(cached);
    } catch {
      // Invalid cache entries are ignored and replaced from data-center.
    }
  }
  // The game-server calls the data-center RPC only; ES remains behind that service.
  const result = await gateway.getRecords(normalized);
  const ttl = Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS));
  await bus.setCache(key, JSON.stringify(result), ttl);
  return result;
}

export async function getCachedRecordDetail({ gateway, bus, userId, gameId, recordId, ttlSeconds = DEFAULT_TTL_SECONDS }) {
  const uid = Number(userId) || 0;
  const gid = Number(gameId) || 0;
  const id = String(recordId || "").slice(0, 256);
  if (!uid || !id) throw new Error("userId and recordId are required");
  const key = `game-record-detail:v1:${uid}:${gid}:${encodeURIComponent(id)}`;
  const cached = await bus.getCache(key);
  if (cached != null) {
    try {
      return JSON.parse(cached);
    } catch {
      // Invalid cache entries are ignored and replaced from data-center.
    }
  }
  const result = await gateway.getRecordDetail({ userId: uid, gameId: gid, recordId: id });
  await bus.setCache(key, JSON.stringify(result), Math.max(1, Math.floor(Number(ttlSeconds) || DEFAULT_TTL_SECONDS)));
  return result;
}
