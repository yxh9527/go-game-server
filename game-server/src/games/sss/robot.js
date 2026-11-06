import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { evaluate, validArrangement } = await rel(import.meta.url, './hand.js', v);
const { pair } = await rel(import.meta.url, './scoring.js', v);
const ratings = new WeakMap();
const rate = option => {
  if (!ratings.has(option)) ratings.set(option, evaluate(option.front, option.middle, option.back));
  return ratings.get(option);
};
export function decisionContext(table, actor) {
  return { point: actor.openingPoint, ante: table.ante,
    opponents: table.hand.players.filter(p => p.uid !== actor.uid && !p.bot).map(p => ({
      point: p.openingPoint, plans: (p.result ? [{ front: p.front, middle: p.middle, back: p.back }] : p.options.slice(0, 3))
        .filter(plan => validArrangement(p.hole, plan.front, plan.middle, plan.back)).map(plan => ({
          front: plan.front.slice(), middle: plan.middle.slice(), back: plan.back.slice() })),
    })) };
}
export function choose(options, random = Math.random, context) {
  if (!options.length) return null;
  if (context?.opponents.some(p => p.plans.length)) {
    const candidates = options.filter(option => !rate(option).isWater).map(option => {
      const result = rate(option); let total = 0;
      for (const opponent of context.opponents) {
        if (!opponent.plans.length) continue;
        const values = opponent.plans.map(plan => {
          const compared = pair({ result }, { result: rate(plan) });
          const water = (compared.water.reduce((n, w) => n + w, 0) + compared.specialWater)
            * (compared.horse ? 2 : 1) * (compared.oneScoop || compared.twoScoop ? 2 : 1);
          return Math.sign(water) * Math.min(Math.abs(water * context.ante), context.point, opponent.point);
        });
        total += values.reduce((n, x) => n + x, 0) / values.length * 0.8 + Math.min(...values) * 0.2;
      }
      return { option, value: total };
    }).sort((a, b) => b.value - a.value);
    if (candidates.length) {
      const near = candidates.filter(c => c.value >= candidates[0].value - context.ante * 0.1);
      return near[Math.min(near.length - 1, Math.floor(random() * near.length))].option;
    }
  }
  return options[random() < 0.85 ? 0 : Math.floor(random() * options.length)];
}
export function thinkTime(random = Math.random) { return 6500 + Math.floor(random() * 6500); }
