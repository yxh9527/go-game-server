// Original TurntableConfig: 1..12 = outer type + inner colour,
// 13..15 = colour; 16..30 are the complements of 1..15.
export const AREA_IDS = Object.freeze(Array.from({ length: 30 }, (_, i) => i + 1));
const repeated = (...groups) => groups.flatMap(([value, count]) => Array(count).fill(value));
const regularInner = repeated([1, 8], [2, 8], [3, 8]);
const rareInner = [3, ...Array(11).fill(1), 3, ...Array(11).fill(2)];
const rareOuter = [1,4,3,4,3,4,2,4,3,4,3,4,2,4,3,4,3,4,2,4,3,4,3,4];
const profiles = {
  53: { key: 'bcbm', name: '奔驰宝马', configId: 103,
    outer: [1,4,2,4,3,4,2,4,3,4,3,4,1,4,2,4,3,4,2,4,3,4,3,4], inner: regularInner,
    odds: [35,17,11,5,35,17,11,5,35,17,11,5,2,2,2,0.02,0.05,0.09,0.20,0.02,0.05,0.09,0.20,0.02,0.05,0.09,0.20,0.5,0.5,0.5] },
  54: { key: 'slwh', name: '森林舞会', configId: 104,
    outer: [3,4,2,1,3,4,2,4,3,4,1,3,4,3,2,1,3,4,2,3,4,3,1,4],
    inner: [3,2,...Array(21).fill(1),2],
    odds: [5.85,5.85,2.42,2.42,71,71,35,35,143,143,71,71,0.14,11,23,0.17,0.17,0.41,0.41,0.01,0.01,0.02,0.02,0.006,0.006,0.01,0.01,7,0.09,0.04] },
  55: { key: 'fqzs', name: '飞禽走兽', configId: 105,
    outer: Array.from({ length:24 }, (_, i) => i % 4 + 1), inner: repeated([3,8],[1,8],[2,8]),
    odds: [...Array(12).fill(11),...Array(3).fill(2),...Array(12).fill(0.09),...Array(3).fill(0.5)] },
  56: { key: 'mjzl', name: '麻将转了', configId: 106, outer: rareOuter, inner: rareInner,
    odds: [51.36,16.45,5.54,3.36,51.36,16.45,5.54,3.36,287,95,35,23,1.18,1.18,11,0.01,0.06,0.18,0.29,0.01,0.06,0.18,0.29,0.003,0.01,0.02,0.04,0.84,0.84,0.09] },
  57: { key: 'qwby', name: '趣味捕鱼', configId: 107, outer: rareOuter, inner: rareInner,
    odds: [51.36,16.45,5.54,3.36,51.36,16.45,5.54,3.36,287,95,35,23,1.18,1.18,11,0.01,0.06,0.18,0.29,0.01,0.06,0.18,0.29,0.003,0.01,0.02,0.04,0.84,0.84,0.09] },
};
export function profileFor(roomType) {
  const profile = profiles[Number(roomType)];
  if (!profile) throw new Error('Unsupported arcade roomType=' + roomType);
  return profile;
}
export function winningAreas(outerValue, innerValue) {
  if (![1,2,3,4].includes(outerValue) || ![1,2,3].includes(innerValue)) throw new Error('Invalid wheel result');
  const wins = [(innerValue - 1) * 4 + outerValue, 12 + innerValue];
  return [...wins, ...AREA_IDS.slice(0,15).filter(id => !wins.includes(id)).map(id => id + 15)];
}
export function betNet(hand, bet, odds) {
  if (!hand.winningAreas.includes(bet.areaId)) return -bet.total;
  // Odds use at most three decimal places; calculate integer cents without
  // 100 * 0.29 becoming 28.999999999999996 before flooring.
  return Number(BigInt(bet.total) * BigInt(Math.round(odds[bet.areaId] * 1000)) / 1000n);
}
export function roomRules(row = {}, config = {}) {
  let payload = row.payload || {};
  if (typeof payload === 'string') payload = JSON.parse(payload);
  const profile = profileFor(row.room_type ?? config.roomTypes[0]);
  const params = { ...payload, ...payload[profile.key + 'Params'], ...payload.hundredParams };
  const odds = Object.fromEntries(AREA_IDS.map((id, i) => [id,
    Number(params.betAreaOdds?.[id]?.odds ?? params.betAreaOdds?.[id] ?? profile.odds[i])]));
  if (Object.values(odds).some(n => !Number.isFinite(n) || n < 0 || n > 1000000
    || Math.abs(n * 1000 - Math.round(n * 1000)) > 1e-7)) throw new Error('Invalid arcade odds');
  const track = (value, fallback, max) => {
    const result = value ?? fallback;
    if (!Array.isArray(result) || result.length !== 24 || result.some(n => !Number.isInteger(n) || n < 1 || n > max)) throw new Error('Invalid arcade wheel track');
    return result.slice();
  };
  const amount = (value, fallback) => {
    const n = Number(value ?? fallback);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid arcade bet limit');
    return n;
  };
  const minBet = amount(row.hundred_min_bet ?? params.minBet, 100);
  const maxBet = amount(row.hundred_max_bet ?? params.maxBet, 100000000);
  if (maxBet < minBet || maxBet * (Math.max(...Object.values(odds)) + 1) * AREA_IDS.length > Number.MAX_SAFE_INTEGER) {
    throw new Error('Invalid arcade settlement limit');
  }
  return { roomType: Number(row.room_type ?? config.roomTypes[0]), playMode: 0, key: profile.key,
    gameName: String(params.gameName || profile.name),
    gameRoomConfigId: Number(row.game_room_config_id ?? profile.configId),
    minBet, maxBet, betAreaOdds: odds,
    defaultOuter: track(params.defaultOuter, profile.outer, 4), defaultInner: track(params.defaultInner, profile.inner, 3) };
}
