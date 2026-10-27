export default {
  id: 'niuniu', name: '棋牌牛牛', kind: 'normal', roomTypes: [24],
  confRoomType: 'qznn', minPeople: 2, maxPeople: 7,
  defaultCarryMin: 1000, startDelayMs: 3000, nextHandDelayMs: 10000,
};

export function roomRules(row = {}, table = {}) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch {}
  const p = { ...payload, ...payload.qznnParams, ...row };
  const num = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(p[snake] ?? p[camel]);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const flag = (name, fallback) => p[name] === undefined ? fallback : [true, 1, '1', 'true'].includes(p[name]);
  const mode = num('play_mode', 'playMode', 3);
  const ante = num('ante', 'ante', 10, 1, 100000000);
  const carry = num('carry_min', 'carryMin', 1000, 1, 100000000000);
  const multiples = Array.isArray(p.bettingMultiples) ? p.bettingMultiples.filter(n => Number.isSafeInteger(n) && n > 0 && n <= 100) : [];
  return {
    playMode: mode, ante, carryMin: carry, carryIn: carry,
    maxPeople: num('max_people', 'playerCount', 7, 2, 7), gameStartNum: 2,
    seeCardNo: mode === 0 ? 0 : mode === 7 ? 4 : num('see_card_no', 'seeCardNo', 4, 3, 4),
    grabBankerPoint: num('grab_banker_point', 'grabBankerPoint', mode === 7 ? carry : Math.max(carry, ante * 300), 1),
    grabBankerMax: num('grab_banker_max', 'grabBankerMax', 4, 1, 4),
    bettingMultiples: [...new Set(multiples.length ? multiples : mode === 0 ? [1, 6, 9, 12, 15] : [5, 10, 20, 25])].sort((a, b) => a - b),
    bettingType: 2, doubleRule: mode === 0 ? 3 : num('double_rule', 'doubleRule', 1, 1, 2),
    specialCode: Array.isArray(p.specialCode) ? p.specialCode : [0],
    specialQiLaiCode: Array.isArray(p.specialQiLaiCode) ? p.specialQiLaiCode : [0],
    fastLook: flag('fastLook', true), doublePoint: flag('doublePoint', true),
    disusePoint: num('disuse_point', 'disusePoint', Math.max(0, carry - 100)),
    randomSit: flag('randomSit', true), banTalk: flag('banTalk', true), banEmulator: flag('banEmulator', false),
    taxType: num('tax_type', 'taxType', 0), taxPercent: num('tax_percent', 'taxPercent', 0, 0, 10000),
    maxTax: num('max_tax', 'maxTax', 0),
    grabBankerTime: num('grab_banker_time', 'grabBankerTime', 5000, 1000, 30000),
    raiseTime: num('raise_time', 'raiseTime', 5000, 1000, 30000),
    fastTime: num('fast_time', 'fastTime', 5000, 1000, 30000),
    settleTime: num('settle_time', 'settleTime', 10000, 1000, 30000),
  };
}
