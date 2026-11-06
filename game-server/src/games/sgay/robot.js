import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { evaluate } = await rel(import.meta.url, './hand.js', v);
const { payouts } = await rel(import.meta.url, './scoring.js', v);
const { humanCards, sampleDeals } = await rel(import.meta.url, '../../core/robot-cards.js', v);
export function decisionContext(table, actor) {
  const h = table.hand;
  return { hand: h, uid: actor.uid, opponents: humanCards(h.players, actor.uid),
    players: h.players.map(p => ({ uid: p.uid, pos: p.pos, openingPoint: p.openingPoint, bet: p.bet })), rules: h.rules };
}
export function chooseMultiple({ cards, maxMultiple, point, ante, context }, random = Math.random) {
  const visible = cards.slice(0, 2).filter(c => Number.isInteger(c) && c >= 0 && c < 52);
  const maximum = Math.max(1, Math.min(maxMultiple, Math.floor(point / ante)));
  if (context && visible.length === 2) {
    const deals = sampleDeals({ ...context, visible, size: 3 });
    const ranked = deals.map(deal => [evaluate(deal.own), ...deal.rivals.map(evaluate)]);
    let best = 1, bestValue = -Infinity;
    for (let multiple = 1; multiple <= maximum; multiple++) {
      let total = 0, risk = 0;
      for (const result of ranked) {
        const players = [context.players.find(p => p.uid === context.uid),
          ...context.opponents.map(p => context.players.find(other => other.uid === p.uid))]
          .map((p, i) => ({ ...p, result: result[i], bet: i === 0 ? ante * multiple
            : p.bet ?? Math.min(p.openingPoint, ante * 2) }));
        const score = payouts(players, ante, context.rules.taxPercent, context.rules.maxTax).find(p => p.uid === context.uid).score;
        total += score; risk += Math.max(0, -score);
      }
      const value = (total - risk * (point < ante * 20 ? 0.2 : 0.05)) / Math.max(1, deals.length);
      if (value > bestValue + 0.01) { best = multiple; bestValue = value; }
    }
    return best;
  }
  const ranks = visible.map(c => c % 13 + 1);
  const pair = ranks.length === 2 && ranks[0] === ranks[1];
  const faces = ranks.filter(r => r >= 11).length;
  const cautious = point < ante * 20;
  const roll = random();
  let multiple = roll < 0.50 ? 1 : roll < 0.78 ? 2 : roll < 0.94 ? 3 : 5;
  if (!cautious && (pair || faces === 2) && random() < 0.5) multiple += 2;
  if (cautious) multiple = Math.min(multiple, 2);
  return Math.max(1, Math.min(maximum, multiple));
}
export const thinkTime = (phase, random = Math.random) => phase === 'bet'
  ? 650 + Math.floor(random() * 2200) : 1400 + Math.floor(random() * 2500);
