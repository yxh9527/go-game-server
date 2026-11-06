import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { compareKey } = await rel(import.meta.url, './hand.js', v);

// Shared pile/scoop assessment for settlement and robot arrangement scoring.
export function pair(a, b) {
  const ar = a.result, br = b.result, water = [0, 0, 0];
  let specialWater = 0;
  const horse = ar.hasHorseCard || br.hasHorseCard;
  if (ar.isWater || br.isWater) {
    if (ar.isWater !== br.isWater) {
      const winner = ar.isWater ? br : ar, sign = ar.isWater ? -1 : 1;
      if (winner.hasSpecialType) specialWater = sign * winner.specialType.water;
      else ['frontHand', 'middleHand', 'backHand'].forEach((k, i) => water[i] = sign * winner[k].water);
    }
  } else if (ar.hasSpecialType || br.hasSpecialType) {
    const x = ar.specialType, y = br.specialType;
    const cmp = x && y ? Math.sign(x.strength - y.strength) : x ? 1 : -1;
    specialWater = cmp * (cmp > 0 ? x.water : cmp < 0 ? y.water : 0);
  } else {
    ['frontHand', 'middleHand', 'backHand'].forEach((k, i) => {
      const cmp = compareKey(ar[k].key, br[k].key);
      water[i] = cmp > 0 ? ar[k].water : cmp < 0 ? -br[k].water : 0;
    });
  }
  const oneScoop = !specialWater && !ar.isWater && !br.isWater && !ar.hasSpecialType && !br.hasSpecialType
    && water.every(n => n >= 0) && water.some(n => n > 0);
  const twoScoop = !specialWater && !ar.isWater && !br.isWater && !ar.hasSpecialType && !br.hasSpecialType
    && water.every(n => n <= 0) && water.some(n => n < 0);
  return { a, b, water, specialWater, horse, oneScoop, twoScoop };
}
