export const MODES = Object.freeze({
  1: { name: '明牌红1黑1', redCards: 1, blackCards: 1 },
  2: { name: '明牌红2黑1', redCards: 2, blackCards: 1 },
  3: { name: '明牌红2黑2', redCards: 2, blackCards: 2 },
  4: { name: '明牌红3黑1', redCards: 3, blackCards: 1 },
  5: { name: '全暗', redCards: 0, blackCards: 0 },
});

export default {
  id: 'hundred-zjh', name: '百人金花', kind: 'hundred', roomTypes: [51],
  confRoomType: 51, defaultConfigId: 101, minBet: 100, maxBet: 1000000000,
  betSeconds: 20, revealSeconds: 3, nextRoundSeconds: 5, modes: MODES,
  rejectZeroOdds: true,
  initialWays: () => ({ 1: { max: 100, targetValue: [], ways: [] } }),
};

export function roomRules(row = {}, config = {}) {
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch {}
  const params = { ...payload, ...(payload.hundredParams || {}) };
  const playMode = Number(row.play_mode ?? params.playMode ?? 1);
  if (!MODES[playMode]) throw new Error('Unsupported hundred Jinhua playMode=' + playMode);
  const positive = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
  return { ...MODES[playMode], playMode, roomType: 51,
    gameRoomConfigId: Number(row.game_room_config_id ?? params.gameRoomConfigId),
    minBet: positive(row.hundred_min_bet ?? params.minBet, config.minBet || 100),
    maxBet: positive(row.hundred_max_bet ?? params.maxBet, config.maxBet || 1000000000),
    gameName: String(params.gameName || MODES[playMode].name + '(底注1)'),
    betAreaOdds: Object.fromEntries(Array.from({length: 8}, (_, i) => [i + 1, 0])),
  };
}
