export default {
  id: "zjh",
  name: "炸金花",
  kind: "normal",
  roomTypes: [25],
  confRoomType: "ctjh",
  minPeople: 2,
  maxPeople: 7,
  betTime: 11,
  defaultAnte: 10,
  defaultCarryMin: 100,
  buyInMultiple: 50,
  startDelayMs: 3000,
  nextHandDelayMs: 8000,
  // Original ZjhBipaiPanel closes itself after three seconds.
  compareAnimationMs: 3500,
  maxRounds: 8,
  forceShowCard: true,
};

// Configuration values are protocol score units (100 = one displayed chip).
// Keep room policy separate from hand state so hot reload never replaces seats.
export function roomRules(row = {}, table = {}) {
  let payload = {};
  try { payload = JSON.parse(row?.payload || "{}"); } catch {}
  const params = { ...payload, ...(payload.ctjhParams || {}), ...row };
  const number = (snake, camel, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
    const value = Number(params[snake] ?? params[camel]);
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  };
  const flag = (snake, camel, fallback) => {
    const value = params[snake] ?? params[camel];
    return value === true || value === 1 || value === "1" || value === "true" ? true
      : value === false || value === 0 || value === "0" || value === "false" ? false : fallback;
  };
  const ante = Number(table.ante) || number("ante", "ante", 10, 1);
  const carryMin = Number(table.carryMin) || number("carry_min", "carryMin", 100, 1);
  const lookTwo = number("play_mode", "playMode", 3) === 2;
  return {
    maxPeople: Math.floor(number("max_people", "maxPeople", 7, 2, 7)),
    disusePoint: number("disuse_point", "disusePoint", Math.max(0, carryMin - ante)),
    gameStartNum: 2,
    randomSit: flag("random_sit", "randomSit", true),
    banTalk: flag("ban_talk", "banTalk", true),
    banEmulator: flag("ban_emulator", "banEmulator", false),
    taxType: number("tax_type", "taxType", lookTwo ? 2 : 0),
    taxPercent: number("tax_percent", "taxPercent", lookTwo ? 500 : 0, 0, 10000),
    maxTax: number("max_tax", "maxTax", 0),
  };
}
