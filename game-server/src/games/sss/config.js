export default {
  id: 'sss', name: '十三水', kind: 'normal', roomTypes: [27], confRoomType: 'sss',
  minPeople: 2, maxPeople: 4, defaultCarryMin: 1000, startDelayMs: 3000,
  incrementalSeatUpdates: true,
};

export function roomRules(row = {}) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch {}
  const p = { ...payload, ...payload.sssParams, ...row };
  const num = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(p[snake] ?? p[camel]);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const flag = (key, fallback) => p[key] === undefined ? fallback : [true, 1, '1', 'true'].includes(p[key]);
  const ante = num('ante', 'ante', 10, 1, 100000000);
  const carryMin = num('carry_min', 'carryMin', 1000, 1, 100000000000);
  return {
    playMode: num('play_mode', 'playMode', 0, 0, 1), ante, carryMin, carryIn: carryMin,
    maxPeople: num('max_people', 'playerCount', 4, 2, 4), playerCount: 4,
    gameStartNum: num('game_start_num', 'gameStartNum', 2, 2, 4),
    arrangeTime: num('arrange_time', 'arrangeTime', 90, 5, 180),
    arrangeExtendCount: num('arrange_extend_count', 'arrangeExtendCount', 2, 0, 3),
    arrangeExtendSeconds: num('arrange_extend_seconds', 'arrangeExtendSeconds', 30, 5, 60),
    settleTime: num('settle_time', 'settleTime', 22000, 18000, 60000),
    fastLook: flag('fastLook', true), observed: true, betTime: 0,
    gameTime: 28800, carryDefault: carryMin, carryMax: -1,
    disusePoint: num('disuse_point', 'disusePoint', Math.max(0, carryMin - ante * 10)),
    randomSit: flag('randomSit', true), banTalk: flag('banTalk', true),
    banEmulator: flag('banEmulator', false), autoCreate: true,
    // No rake is applied without an authoritative configured accounting contract.
    taxType: 0, taxPercent: 0, maxTax: 0,
  };
}
