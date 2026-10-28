export default {
  id: 'sgay', name: '三公暗一', kind: 'normal', roomTypes: [32], confRoomType: 'sgya',
  minPeople: 2, maxPeople: 7, defaultCarryMin: 5000, startDelayMs: 3000, nextHandDelayMs: 5000,
};

export function roomRules(row = {}) {
  row ||= {};
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}') || {}; } catch {}
  const p = { ...payload, ...payload.sgyaParams, ...row };
  const n = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(p[snake] ?? p[camel]);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  };
  if (n('play_mode', 'playMode', 0) !== 0) throw new Error('Unsupported Sgay playMode');
  const ante = n('ante', 'ante', 500, 1, 100000000);
  const carryMin = n('carry_min', 'carryMin', 5000, ante, 100000000000);
  return { playMode: 0, ante, carryMin, maxPeople: 7, gameStartNum: 2,
    roomClassification: n('room_classification', 'roomClassification', 2),
    randomSit: p.randomSit !== false, banTalk: p.banTalk !== false,
    openInsurance: false, forceShowCard: false, forceShowType: 0, delayLook: false,
    maxRounds: 8, maxSingleBet: 0, baoZiTime: 0,
    betTimeMs: n('bet_time_ms', 'betTimeMs', 5000, 1000, 30000),
    revealTimeMs: n('reveal_time_ms', 'revealTimeMs', 8000, 1000, 30000),
    dealTimeMs: n('deal_time_ms', 'dealTimeMs', 1200, 500, 5000),
    settleTimeMs: n('settle_time_ms', 'settleTimeMs', 5000, 4000, 15000),
    taxType: n('tax_type', 'taxType', 2),
    taxPercent: n('tax_percent', 'taxPercent', 500, 0, 10000),
    maxTax: n('max_tax', 'maxTax', 0),
  };
}
