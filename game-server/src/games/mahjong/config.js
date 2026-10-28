export default { id: 'mahjong', name: '麻将', kind: 'normal', roomTypes: [26, 28, 30],
  minPeople: 2, maxPeople: 4, defaultCarryMin: 2000, startDelayMs: 3000, nextHandDelayMs: 5000 };
export function roomRules(row = {}) {
  let payload = {}; try { payload = JSON.parse(row.payload || '{}'); } catch {}
  const type = Number(row.room_type ?? payload.roomType), family = { 26: 'jsmj', 28: 'csmj', 30: 'hzxl' }[type];
  if (!family) throw new Error('Unknown Mahjong room type');
  const p = { ...payload, ...payload[family + 'Params'], ...row };
  const n = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const x = Number(p[snake] ?? p[camel]); return Number.isSafeInteger(x) && x >= min && x <= max ? x : fallback;
  };
  const playMode = n('play_mode', 'playMode', family === 'csmj' ? 4 : 0);
  if (!(family === 'csmj' ? [2, 4] : [0, 1]).includes(playMode)) throw new Error('Unsupported Mahjong playMode');
  const maxPeople = family === 'csmj' ? playMode : playMode === 1 ? 2 : 4;
  const diFen = n('ante', 'diFen', 10, 1, 100000000);
  return { family, playMode, maxPeople, gameStartNum: maxPeople, diFen, ante: diFen,
    carryMin: n('carry_min', 'carryMin', 2000, diFen, 100000000000),
    roomClassification: n('room_classification', 'roomClassification', 2),
    cardNum: family === 'jsmj' && maxPeople === 2 ? 52 : 0,
    opTime: n('op_time', 'opTime', 10, 2, 60), responseTime: n('response_time', 'responseTime', 5, 2, 30),
    prepareTimeMs: n('prepare_time_ms', 'prepareTimeMs', 5000, 1000, 15000),
    dealTimeMs: n('deal_time_ms', 'dealTimeMs', 5000, 3000, 10000),
    randomSit: true, banTalk: true, taxType: 2, taxPercent: n('tax_percent', 'taxPercent', 500, 0, 10000) };
}
