export const MODES = Object.freeze({
  1: { name: '牛牛看三张', visibleCount: 3 },
  2: { name: '牛牛看四张', visibleCount: 4 },
  3: { name: '牛牛看二张', visibleCount: 2 },
  4: { name: '牛牛看一张', visibleCount: 1 },
  5: { name: '牛牛全暗', visibleCount: 0 },
});
export default {
  id: 'hundred-niuniu', name: '百人牛牛', kind: 'hundred', roomTypes: [52],
  confRoomType: 52, defaultConfigId: 102, minBet: 100, maxBet: 1000000000,
  betSeconds: 20, revealSeconds: 3, nextRoundSeconds: 5, rejectZeroOdds: true,
  betBalanceFactor: 10, modes: MODES,
  initialWays: () => ({ 1: { max: 100, ways: { 1: [], 2: [], 3: [] } },
    2: { max: 100, ways: [], aWinCount: 0, bWinCount: 0, cWinCount: 0 } }),
};
export function roomRules(row = {}, config = {}) {
  let payload = {};
  try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch {}
  const params = { ...payload, ...payload.hundredParams };
  const playMode = Number(row.play_mode ?? params.playMode ?? 1);
  if (!MODES[playMode]) throw new Error('Unsupported hundred Niuniu playMode=' + playMode);
  const positive = (n, fallback) => Number.isSafeInteger(Number(n)) && Number(n) > 0 ? Number(n) : fallback;
  const specialPayoutMultiple = Number(params.specialPayoutMultiple ?? 10);
  if (!Number.isInteger(specialPayoutMultiple) || specialPayoutMultiple < 1 || specialPayoutMultiple > 10)
    throw new Error('Invalid hundred Niuniu special payout multiplier');
  return { ...MODES[playMode], playMode, roomType: 52,
    specialPayoutMultiple,
    gameRoomConfigId: Number(row.game_room_config_id ?? params.gameRoomConfigId),
    minBet: positive(row.hundred_min_bet ?? params.minBet, config.minBet || 100),
    maxBet: positive(row.hundred_max_bet ?? params.maxBet, config.maxBet || 1000000000),
    gameName: String(params.gameName || MODES[playMode].name + '(底注1)'),
    betAreaOdds: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i + 1, 1])),
  };
}
