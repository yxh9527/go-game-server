const MODES = Object.freeze({
  1: { name: "暗五公牌", theme: ["牛仔", "美女"], boardCards: 0, privateCards: true },
  2: { name: "明三公牌", theme: ["冲浪男孩", "热辣美女"], boardCards: 3, privateCards: true },
  3: { name: "明二公牌", theme: ["司马懿", "诸葛亮"], boardCards: 2, privateCards: true },
  4: { name: "明一公牌", theme: ["岳飞", "梁红玉"], boardCards: 1, privateCards: true },
  5: { name: "全暗", theme: ["钢铁侠", "奥创"], boardCards: 0, privateCards: false },
});

export default {
  id: "hundred-holdem",
  name: "百人德州",
  kind: "hundred",
  roomTypes: [50],
  confRoomType: 50,
  defaultConfigId: 100,
  minBet: 100,
  maxBet: 1000000000,
  betSeconds: 20,
  revealSeconds: 3,
  nextRoundSeconds: 5,
  modes: MODES,
  // Development-room display defaults only. Live room configuration or a
  // per-hand odds payload always takes precedence.
  fallbackOdds: Object.freeze({ 1: 1.91, 2: 0.5, 3: 16.44, 4: 1.61, 5: 2.03, 6: 13.22, 7: 4.9 }),
};

export function roomRules(row = {}, config = null) {
  let payload = {};
  try { payload = typeof row.payload === "string" ? JSON.parse(row.payload || "{}") : (row.payload || {}); } catch {}
  const params = { ...payload, ...(payload.hundredParams || {}), ...(config || {}) };
  const playMode = Number(row.play_mode ?? params.playMode ?? 1);
  if (!MODES[playMode]) throw new Error(`Unsupported hundred Texas playMode=${playMode}`);
  const parsedOdds = params.betAreaOdds ?? params.bet_area_odds ?? row.bet_area_odds;
  let odds = {};
  try { odds = typeof parsedOdds === "string" ? JSON.parse(parsedOdds) : (parsedOdds || {}); } catch {}
  const maxBetValue = Number(row.hundred_max_bet ?? params.maxBet ?? params.hundredMaxBet);
  const minBetValue = Number(row.hundred_min_bet ?? params.minBet ?? params.hundredMinBet);
  return {
    ...MODES[playMode], playMode,
    roomType: 50,
    gameRoomConfigId: Number(row.game_room_config_id ?? params.gameRoomConfigId) || 0,
    minBet: Number.isSafeInteger(minBetValue) && minBetValue > 0 ? minBetValue : config?.minBet || 100,
    maxBet: Number.isSafeInteger(maxBetValue) && maxBetValue > 0 ? maxBetValue : config?.maxBet || 1000000000,
    betAreaOdds: Object.fromEntries(Array.from({ length: 7 }, (_, i) => {
      const id = i + 1;
      const value = Number(odds[id]);
      return [id, Number.isFinite(value) && value >= 0 ? value : config?.fallbackOdds?.[id] || 0];
    })),
    gameName: String(params.gameName || `${MODES[playMode].name}(底注1)`),
  };
}
