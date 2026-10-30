export default {
  id: 'hundred-blackjack', name: '百人二十一点', kind: 'hundred', roomTypes: [60],
  confRoomType: 60, defaultConfigId: 6001, minBet: 100, maxBet: 1000000000,
  betSeconds: 20, revealSeconds: 5, nextRoundSeconds: 3, rejectZeroOdds: true,
  initialWays: () => ({ 1: { max: 100, ways: { 1: [], 2: [], 3: [] } },
    2: { max: 100, ways: [], aWinCount: 0, bWinCount: 0, cWinCount: 0 } }),
};
export function roomRules(row = {}, config = {}) {
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch {}
  const params = { ...payload, ...payload.hundredParams };
  const playMode = Number(row.play_mode ?? params.playMode ?? 0);
  if (playMode !== 0) throw new Error('Unsupported hundred Blackjack playMode=' + playMode);
  const positive = (n, fallback) => Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
  const cutIndex = Number(params.cutIndex ?? 262);
  if (!Number.isInteger(cutIndex) || cutIndex < 8 || cutIndex > 292) throw new Error('Invalid hundred Blackjack cutIndex');
  return { playMode, roomType: 60, cutIndex,
    gameRoomConfigId: Number(row.game_room_config_id ?? params.gameRoomConfigId ?? 6001),
    minBet: positive(row.hundred_min_bet ?? params.minBet, config.minBet || 100),
    maxBet: positive(row.hundred_max_bet ?? params.maxBet, config.maxBet || 1000000000),
    gameName: String(params.gameName || '百人21点'),
    betAreaOdds: Object.fromEntries([1, 2, 3, 4, 5, 6].map(id => [id, 1])),
  };
}
