export default {
  id: 'blackjack', name: '常规二十一点', kind: 'normal', roomTypes: [31], confRoomType: 'bj21',
  minPeople: 1, maxPeople: 3, defaultCarryMin: 500, startDelayMs: 3000, incrementalSeatUpdates: true,
};

export function roomRules(row = {}) {
  let payload = {};
  try { payload = JSON.parse(row.payload || '{}'); } catch {}
  const p = { ...payload, ...payload.bj21Params, ...row };
  if (Number(p.play_mode ?? p.playMode ?? 0) !== 0) throw new Error('Only ordinary blackjack playMode=0 is supported');
  const num = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const n = Number(p[snake] ?? p[camel]);
    return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
  };
  const ante = num('ante', 'ante', 100, 1, 100000000);
  const carryMin = num('carry_min', 'carryMin', 500, 1, 100000000000);
  const maxBet = num('max_bet', 'maxBet', ante * 100, ante, 10000000000);
  return { ante, minBet: ante, maxBet, gameName: String(p.gameName || `常规21点(${ante / 100}/${maxBet / 100})`),
    carryIn: carryMin, carryMin, carryMax: 0, carryDefault: carryMin, playMode: 0,
    maxPeople: 3, gameStartNum: 1, gameTime: 28800,
    betTime: num('bet_time', 'betTime', 10, 5, 60),
    operateTime: num('operate_time', 'operateTime', 10, 5, 60),
    insuranceTime: num('insurance_time', 'insuranceTime', 8, 5, 60),
    dealTime: num('deal_time', 'dealTime', 4500, 3000, 15000),
    settleTime: num('settle_time', 'settleTime', 5000, 5000, 60000),
    pairMinBet: 0, pairMaxBet: 0, notPairMinBet: 0, notPairMaxBet: 0,
    observed: true, randomSit: true, banTalk: true, banSameIP: false,
    taxType: 0, taxPercent: 0, maxTax: 0 };
}
