import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { areaIds, point, winningAreas } = await rel(import.meta.url, './rules.js', v);

export function configuredOdds(config, mode = 0) {
  return Object.fromEntries(areaIds(mode).map(id => {
    const price = Math.round(Number(config.odds[id] ?? 0) * 100);
    return [id, { id, odds: price / 100, oddsList: [price] }];
  }));
}

// Development conditional prices. Only public dragon and remaining card
// composition are used; the actual hidden tiger position is never inspected.
// The online operator's pricing/return policy is not yet verified.
export function brightOdds(remaining, dragon) {
  point(dragon);
  const candidates = remaining.slice(), index = candidates.indexOf(dragon);
  if (index < 0 || candidates.length < 2) throw new Error('Invalid dragon-tiger remaining shoe');
  candidates.splice(index, 1);
  const counts = Object.fromEntries(areaIds(3).map(id => [id, { win: 0, lose2: 0 }]));
  for (const tiger of candidates) {
    const result = winningAreas(dragon, tiger, 3);
    for (const id of areaIds(3)) {
      if (result.areas.includes(id)) counts[id].win++;
      else counts[id].lose2 += result.result === 0 && [1, 2].includes(id) ? 1 : 2;
    }
  }
  return Object.fromEntries(areaIds(3).map(id => {
    const price = counts[id].win ? Math.floor(counts[id].lose2 * 50 / counts[id].win) : 0;
    return [id, { id, odds: price / 100, oddsList: [price] }];
  }));
}
