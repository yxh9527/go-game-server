import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { cardValue, evaluate, compare } = await rel(import.meta.url, './hand.js', v);
export const thinkTime = () => 800 + Math.floor(Math.random() * 1800);
export function betAmount(point, ante, maxBet, rng = Math.random) {
  const units = rng() < .75 ? 1 : rng() < .8 ? 2 : 3;
  return Math.min(point, maxBet, ante * units);
}
// Every player's issued blackjack cards are face up. The system dealer follows
// fixed rules; its concealed card and the remaining shoe are never consulted.
export function decisionContext(table, actor) {
  return { exposed: [table.hand.dealer[0], ...table.hand.players.flatMap(p => p.hands.flatMap(h => h.cards))],
    splitHand: Boolean(actor.hands[actor.currentHandIndex]?.splitHand), noBlackjack: true };
}
function distribution(exposed) {
  const remaining = [0, 24, 24, 24, 24, 24, 24, 24, 24, 24, 96];
  for (const c of exposed) if (Number.isInteger(c) && c >= 0 && c < 52) remaining[cardValue(c)] = Math.max(0, remaining[cardValue(c)] - 1);
  const total = remaining.reduce((n, x) => n + x, 0);
  return remaining.map(n => n / total);
}
export function buyInsurance(context) { return distribution(context.exposed)[10] > 1 / 3; }
export function actionValues(cards, upCard, actions, context) {
  const probabilities = distribution(context.exposed), dealerMemo = new Map(), playerMemo = new Map();
  const key = list => { const e = evaluate(list); return [list.length, e.pointValue, e.soft].join('/'); };
  const eachDraw = fn => probabilities.reduce((sum, chance, rank) => rank && chance ? sum + chance * fn(rank - 1) : sum, 0);
  const dealer = list => {
    const id = key(list);
    if (dealerMemo.has(id)) return dealerMemo.get(id);
    const e = evaluate(list), result = new Map();
    if (e.pointValue >= 17 || list.length >= 5) result.set(e.handType + '/' + e.pointValue, { value: e, chance: 1 });
    else for (let rank = 1; rank <= 10; rank++) {
      if (!probabilities[rank]) continue;
      for (const [k, value] of dealer([...list, rank - 1])) {
        const row = result.get(k) || { value: value.value, chance: 0 };
        row.chance += probabilities[rank] * value.chance; result.set(k, row);
      }
    }
    dealerMemo.set(id, result); return result;
  };
  const outcomes = [];
  for (let rank = 1; rank <= 10; rank++) {
    const start = [upCard, rank - 1];
    if (context.noBlackjack && evaluate(start).handType === 5) continue;
    for (const row of dealer(start).values()) outcomes.push({ value: row.value, chance: probabilities[rank] * row.chance });
  }
  const normalizer = outcomes.reduce((n, row) => n + row.chance, 0);
  const stand = (list, split) => {
    const e = evaluate(list, split);
    return outcomes.reduce((sum, row) => {
      const won = compare(e, row.value);
      return sum + row.chance * (won > 0 ? [4, 5].includes(e.handType) ? 1.5 : 1 : won < 0 ? -1 : 0);
    }, 0) / normalizer;
  };
  const optimal = (list, split) => {
    const id = key(list) + '/' + split;
    if (playerMemo.has(id)) return playerMemo.get(id);
    const e = evaluate(list, split), value = e.pointValue >= 21 || list.length >= 5 ? stand(list, split)
      : Math.max(stand(list, split), eachDraw(card => optimal([...list, card], split)));
    playerMemo.set(id, value); return value;
  };
  const values = {};
  if (actions.includes('STAND')) values.STAND = stand(cards, context.splitHand);
  if (actions.includes('HIT')) values.HIT = eachDraw(card => optimal([...cards, card], context.splitHand));
  if (actions.includes('DOUBLE')) values.DOUBLE = 2 * eachDraw(card => stand([...cards, card], context.splitHand));
  if (actions.includes('SPLIT')) values.SPLIT = cards.reduce((n, first) => n + eachDraw(card => optimal([first, card], true)), 0);
  return values;
}
export function choose(cards, upCard, actions, context) {
  if (context) {
    const values = actionValues(cards, upCard, actions, context);
    return Object.keys(values).sort((a, b) => values[b] - values[a])[0] || actions[0];
  }
  const value = evaluate(cards), up = cardValue(upCard) === 1 ? 11 : cardValue(upCard);
  const has = action => actions.includes(action);
  if (has('SPLIT') && [1, 8].includes(cardValue(cards[0]))) return 'SPLIT';
  if (has('DOUBLE') && (!value.soft && (value.pointValue === 11 || value.pointValue === 10 && up <= 9
    || value.pointValue === 9 && up >= 3 && up <= 6) || value.soft && value.pointValue >= 16 && value.pointValue <= 18 && up >= 4 && up <= 6)) return 'DOUBLE';
  if (value.soft) return value.pointValue >= 19 || value.pointValue === 18 && up >= 2 && up <= 8 ? 'STAND' : 'HIT';
  return value.pointValue >= 17 || value.pointValue >= 13 && up >= 2 && up <= 6
    || value.pointValue === 12 && up >= 4 && up <= 6 ? 'STAND' : 'HIT';
}
