export const NORMAL_AREAS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 15]);
export const BRIGHT_AREAS = Object.freeze([1, 2, 3, 12, 13, 14, 15]);
export const areaIds = mode => Number(mode) === 3 ? BRIGHT_AREAS : NORMAL_AREAS;

export function point(card) {
  if (!Number.isInteger(card) || card < 0 || card >= 52) throw new Error('Invalid dragon-tiger card');
  return card % 13 + 1;
}

// Original card encoding: diamonds, clubs, hearts, spades (13 ranks each).
const red = card => Math.floor(card / 13) % 2 === 0;
export function winningAreas(dragon, tiger, mode = 0) {
  const d = point(dragon), t = point(tiger), result = d > t ? 1 : d < t ? 2 : 0;
  const areas = [result || 3];
  if (Number(mode) === 3) {
    const total = d + t;
    areas.push(total <= 9 ? 12 : total <= 18 ? 13 : 14);
  } else {
    areas.push(d % 2 ? 4 : 5, red(dragon) ? 6 : 7,
      t % 2 ? 8 : 9, red(tiger) ? 10 : 11);
  }
  if (result) areas.push(15);
  return { areas, d, t, result };
}

export function netScore(bet, result, price) {
  if (!Number.isSafeInteger(bet.total) || bet.total <= 0 || !Number.isSafeInteger(price) || price < 0) {
    throw new Error('Invalid dragon-tiger settlement amount');
  }
  if (result.areas.includes(3) && [1, 2].includes(bet.areaId)) {
    // Exactly half the stake is returned; a non-divisible cent stays at risk.
    return Number(BigInt(bet.total) / 2n) - bet.total;
  }
  return result.areas.includes(bet.areaId) ? Number(BigInt(bet.total) * BigInt(price) / 100n) : -bet.total;
}
