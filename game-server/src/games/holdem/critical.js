import { randomInt } from 'node:crypto';

// Original GameCriticalHelpPanel: one mandatory-ante hand every configured
// number of MINUTES. The room advertises mode 3, individual hands use 0 / 2.
export function criticalRules(table) {
  const match = /^(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?$/.exec(String(table.criticalInterval ?? '5-8').trim());
  const min = match ? Number(match[1]) : NaN;
  const max = match ? Number(match[2] ?? match[1]) : NaN;
  const ante = Number(table.criticalAnte);
  if (!Number.isSafeInteger(ante) || ante <= 0 || !Number.isFinite(min)
    || min <= 0 || !Number.isFinite(max) || max < min || max > 480) {
    throw Object.assign(new Error('Invalid Holdem critical ante or minute interval'), { code: 400 });
  }
  return { ante, minMs: Math.ceil(min * 60_000), maxMs: Math.ceil(max * 60_000) };
}

export function initializeCritical(table, now = Date.now()) {
  if (!table.criticalFlag) return;
  const rules = criticalRules(table);
  if (!Number.isFinite(table.criticalAt)) {
    const createdAt = Number.isFinite(table.createdAt) ? table.createdAt : now;
    table.criticalAt = createdAt + randomInt(rules.minMs, rules.maxMs + 1);
  }
}

export function nextHandRules(table, now = Date.now()) {
  initializeCritical(table, now);
  const critical = Boolean(table.criticalFlag && now >= table.criticalAt);
  if (critical) {
    const rules = criticalRules(table);
    // Do not replay missed intervals after a room wakes up. Hot reload, joining
    // and ordinary hands never reset this room-owned timestamp.
    table.criticalAt = now + randomInt(rules.minMs, rules.maxMs + 1);
  }
  return { critical, playMode: critical ? 2 : 0,
    initialBet: critical ? table.criticalAnte : (table.initialBet ?? table.bigBlind) };
}
