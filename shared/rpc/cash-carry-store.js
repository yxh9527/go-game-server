// Cash-seat reservations are leases, not a wallet or a record of unsettled bets.
// No expiry is ever applied to the financial ledger itself.
export const CARRY_TTL_MS = 300_000;
export const CARRY_SCRIPT = `
local action, token = ARGV[1], ARGV[2]
local current = redis.call('GET', KEYS[1])
if action == 'read' then
  if not current then return '' end
  local record = cjson.decode(current)
  record.ttlMs = redis.call('PTTL', KEYS[1])
  return cjson.encode(record)
end
local old = current and cjson.decode(current) or nil
if action == 'reserve' then
  if old and old.token ~= token then return redis.error_reply('CARRY_CONFLICT') end
elseif not old or old.token ~= token then
  if action == 'release' then return 'OK' end
  return redis.error_reply('CARRY_EXPIRED')
end
if action == 'release' then redis.call('DEL', KEYS[1]); return 'OK' end
if action == 'renew' then redis.call('PEXPIRE', KEYS[1], 300000); return current end
if action ~= 'reserve' and action ~= 'update' then return redis.error_reply('CARRY_ACTION') end
local next = cjson.decode(ARGV[3])
if next.token ~= token or type(next.amount) ~= 'number' or next.amount < 0
  or next.amount % 1 ~= 0 or next.amount > 9007199254740991 then
  return redis.error_reply('CARRY_AMOUNT')
end
if old and action == 'reserve' and current ~= ARGV[3] then return redis.error_reply('CARRY_CONFLICT') end
if old and action == 'update' then
  if next.revision == old.revision and current == ARGV[3] then
    redis.call('PEXPIRE', KEYS[1], 300000); return current
  end
  if next.revision ~= old.revision + 1 then return redis.error_reply('CARRY_REVISION') end
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', 300000)
return ARGV[3]
`;

export function createCashCarryStore(redis) {
  const key = session => {
    if (!Number.isSafeInteger(Number(session.userId)) || Number(session.userId) <= 0
      || !Number.isSafeInteger(Number(session.agentId)) || Number(session.agentId) < 0) throw new Error('Invalid carry account');
    return `gogame:cash-carry:${Number(session.agentId)}:${Number(session.userId)}:${encodeURIComponent(session.currency || 'CNY')}`;
  };
  async function apply(action, session, record = {}) {
    if (!redis?.eval) throw Object.assign(new Error('Redis cash reservation storage unavailable'), { code: 'CARRY_STORE_UNAVAILABLE' });
    if (action !== 'read' && (typeof record.token !== 'string' || !record.token)) throw new Error('Carry token required');
    if (['reserve', 'update'].includes(action) && (!Number.isSafeInteger(record.amount) || record.amount < 0
      || typeof record.tableKey !== 'string' || !record.tableKey
      || !Number.isSafeInteger(record.revision) || record.revision < 1)) throw new Error('Invalid carry record');
    const payload = JSON.stringify({ token: record.token, tableKey: record.tableKey, amount: record.amount, revision: record.revision,
      // A lease expiring must never remove the journal of unresolved wagers.
      userId: Number(session.userId), agentId: Number(session.agentId), currency: session.currency || 'CNY' });
    const result = await redis.eval(CARRY_SCRIPT, 1, key(session), action, record.token || '', payload);
    if (!result || result === 'OK') return null;
    const next = JSON.parse(result);
    if (action === 'read') {
      if (!(next.ttlMs > 0) || next.ttlMs > CARRY_TTL_MS) throw new Error('Invalid cash lease expiry');
      next.expiresAt = Date.now() + next.ttlMs;
    }
    return next;
  }
  return {
    get: session => apply('read', session),
    reserve: (session, record) => apply('reserve', session, record),
    update: (session, record) => apply('update', session, record),
    renew: (session, record) => apply('renew', session, record),
    release: (session, record) => apply('release', session, record),
  };
}
