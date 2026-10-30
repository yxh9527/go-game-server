export default {
  id: 'hundred-mahjong', name: '百人麻将', kind: 'hundred', roomTypes: [62],
  confRoomType: 62, defaultConfigId: 6201, minBet: 100, maxBet: 1000000000,
  betSeconds: 20, revealSeconds: 3, nextRoundSeconds: 5, rejectZeroOdds: true,
  initialWays: () => ({ 1: { max: 100, ways: [] } }),
};
export function roomRules(row = {}, config = {}) {
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch {}
  const params = { ...payload, ...payload.hundredParams };
  const mode = Number(row.play_mode ?? params.playMode ?? 1);
  if (![0, 1].includes(mode)) throw new Error('Unsupported hundred Mahjong playMode=' + mode);
  const positive = (n, fallback) => Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
  return { playMode: 1, roomType: 62, gameName: String(params.gameName || '百人麻将'),
    gameRoomConfigId: Number(row.game_room_config_id ?? params.gameRoomConfigId ?? 6201),
    minBet: positive(row.hundred_min_bet ?? params.minBet, config.minBet || 100),
    maxBet: positive(row.hundred_max_bet ?? params.maxBet, config.maxBet || 1000000000),
    betAreaOdds: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [i + 1, -1])),
  };
}
