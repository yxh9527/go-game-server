import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { evaluate, compareHands } = await rel(import.meta.url, './hand.js', v);
const { humanCards, sampleDeals } = await rel(import.meta.url, '../../core/robot-cards.js', v);
const ranks = new WeakMap();
export function decisionContext(table, actor) {
  return { hand: table.hand, uid: actor.uid, rules: table.hand.rules, laiZi: table.hand.laiZi,
    opponents: humanCards(table.hand.players, actor.uid), bankerUid: table.hand.bankerUid,
    point: actor.openingPoint, ante: table.ante, bankerMultiple: table.hand.bankerMultiple };
}
export function choose({ cards, grabMax = 0, multiples = [], phase, auto, context }, random = Math.random) {
  if (auto) return phase === 'grab' ? Math.max(0, Math.min(grabMax, auto.grab))
    : multiples.filter(n => n <= auto.multiple).at(-1) || multiples[0];
  if (!['grab', 'bet'].includes(phase)) return 0;
  let edge = 0, confidence = 0.5;
  if (context?.rules && context.opponents.length) {
    const deals = sampleDeals({ ...context, visible: cards, size: 5,
      deckSize: context.rules.playMode === 7 ? 55 : 52, samples: context.rules.playMode === 7 ? 16 : 48 });
    let observations = 0, wins = 0;
    for (const deal of deals) {
      let rated = ranks.get(deal);
      if (!rated) {
        rated = [deal.own, ...deal.rivals].map(c => evaluate(c, context.rules, context.laiZi));
        ranks.set(deal, rated);
      }
      for (let i = 0; i < context.opponents.length; i++) {
        if (phase === 'bet' && context.opponents[i].uid !== context.bankerUid) continue;
        const won = compareHands(rated[0], rated[i + 1]) > 0;
        edge += won ? rated[0].belv : -rated[i + 1].belv;
        wins += Number(won); observations++;
      }
    }
    if (observations) { edge /= observations; confidence = wins / observations; }
  } else {
    const faces = cards.filter(c => c >= 52 || c % 13 >= 9).length;
    confidence = cards.length ? Math.min(0.9, 0.18 + faces * 0.12 + cards.filter(c => c >= 52).length * 0.15) : 0.3;
    edge = confidence - 0.5;
  }
  if (phase === 'grab') {
    if (edge <= 0 || confidence < 0.52 || !grabMax) return 0;
    return Math.max(1, Math.min(grabMax, Math.ceil(grabMax * Math.min(1, confidence + (random() - 0.5) * 0.15))));
  }
  if (!multiples.length) return 0;
  if (edge <= 0) return multiples[0];
  const cap = context ? context.point * (confidence >= 0.85 ? 0.65 : 0.3)
    / Math.max(1, context.ante * context.bankerMultiple * (context.rules.playMode === 7 ? 10 : 4)) : Infinity;
  const allowed = multiples.filter(n => n <= cap), choices = allowed.length ? allowed : [multiples[0]];
  const index = Math.min(choices.length - 1, Math.floor((confidence + (random() - 0.5) * 0.12) * choices.length));
  return choices[Math.max(0, index)];
}
