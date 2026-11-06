import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { counts, suit, rank } = await rel(import.meta.url, './tiles.js', v);
const { deckFor } = await rel(import.meta.url, './tiles.js', v);
const { evaluate } = await rel(import.meta.url, './hand.js', v);

export function decisionContext(table, actor) {
  return { rules: table.hand.rules, groups: actor.groupCards,
    opponents: table.hand.players.filter(p => p.uid !== actor.uid && !p.bot).map(p => ({
      cards: p.handCards.slice(), groups: p.groupCards.map(g => ({ ...g, cards: g.cards.slice() })),
      queType: p.queType, ting: p.ting, passedHu: p.passedHu,
    })) };
}
// Partition the concealed tiles into complete sets, pairs and useful partial
// runs. A local memo bounds the search; no undealt tile is read or predicted.
export function shapeValue(cards, family) {
  const c = counts(cards), memo = new Map();
  const visit = () => {
    const first = c.findIndex(n => n > 0);
    if (first < 0) return 0;
    const key = c.join(','); if (memo.has(key)) return memo.get(key);
    c[first]--; let best = visit() + (family === 'hzxl' && first === 27 ? 7 : 0);
    if (c[first]) {
      c[first]--; best = Math.max(best, 3 + visit());
      if (c[first]) { c[first]--; best = Math.max(best, 7 + visit()); c[first]++; }
      c[first]++;
    }
    if (first < 27) {
      for (const delta of [1, 2]) if (first + delta < 27 && suit(first) === suit(first + delta) && c[first + delta]) {
        c[first + delta]--; best = Math.max(best, (delta === 1 ? 2.5 : 1.8) + visit()); c[first + delta]++;
      }
      if (first % 9 <= 6 && c[first + 1] && c[first + 2]) {
        c[first + 1]--; c[first + 2]--; best = Math.max(best, 7 + visit()); c[first + 1]++; c[first + 2]++;
      }
    }
    c[first]++; memo.set(key, best); return best;
  };
  return visit();
}
export function danger(card, context) {
  let risk = 0;
  for (const p of context.opponents) {
    const score = !p.passedHu && evaluate([...p.cards, card], p.groups, context.rules,
      { selfDraw: false, queType: p.queType, ting: p.ting, heaven: false, earth: false });
    if (context.rules.family !== 'jsmj' && score && (context.rules.family !== 'hzxl' || score.fan >= 128)) {
      risk += 18 + Math.log2(1 + score.fan) * 3;
    }
    if (suit(card) === p.queType) continue;
    const n = p.cards.filter(c => c === card).length;
    risk += n >= 2 ? 2 : 0;
    if (context.rules.family === 'csmj' && card < 27) {
      for (let start = Math.max(Math.floor(card / 9) * 9, card - 2); start <= card && start % 9 <= 6; start++) {
        if ([start, start + 1, start + 2].filter(c => c !== card).every(c => p.cards.includes(c))) risk += 0.5;
      }
    }
  }
  return risk;
}

function informedAction(input, rng) {
  const { cards, options, family, queType = 0, ting, drawn, publicCards = [], context, waitsByDiscard = {} } = input;
  const win = options.find(o => [8, 11].includes(o.type)); if (win) return { ...win };
  const first = options.find(o => o.type === 10 && !Array.isArray(o.cards)); if (first) return { ...first };
  const known = counts(cards.concat(publicCards, context.opponents.flatMap(p => p.cards)));
  const available = counts(deckFor(context.rules));
  const discardValue = card => {
    const rest = cards.slice(); rest.splice(rest.indexOf(card), 1);
    const waits = waitsByDiscard[card] || [];
    const live = waits.reduce((n, wait) => n + Math.max(0, available[wait.card] - known[wait.card]), 0);
    return shapeValue(rest, family) + (live ? 12 + live * 0.7 : 0) - danger(card, context) + rng() * 0.2;
  };
  const missing = cards.filter(c => suit(c) === queType);
  const allowed = ting && cards.includes(drawn) ? [drawn] : missing.length ? missing : cards;
  const discards = [...new Set(allowed)].map(card => ({ card, value: discardValue(card) })).sort((a, b) => b.value - a.value || a.card - b.card);
  const declaration = options.find(o => [9, 10].includes(o.type) && Array.isArray(o.cards));
  if (declaration) {
    const target = discards.find(d => declaration.cards.includes(d.card));
    if (target) return { ...declaration, card: target.card };
  }
  for (const type of [4, 5, 6, 16]) {
    const op = options.find(o => o.type === type);
    if (op) {
      const rob = type === 5 && context.rules.family === 'csmj' && danger(op.card, context) >= 18;
      if (!rob) return { ...op };
    }
  }
  const melds = [];
  for (const op of options.filter(o => [3, 12].includes(o.type))) {
    for (const used of op.type === 12 ? op.cards : [[op.card, op.card]]) {
      const rest = cards.slice();
      for (const card of used) rest.splice(rest.indexOf(card), 1);
      const best = Math.max(...[...new Set(rest)].map(card => {
        const after = rest.slice(); after.splice(after.indexOf(card), 1);
        return shapeValue(after, family) + 7 - danger(card, context);
      }));
      melds.push({ op: { ...op, ...(op.type === 12 ? { chiUseCards: used.slice() } : {}) }, value: best });
    }
  }
  melds.sort((a, b) => b.value - a.value);
  if (melds[0] && melds[0].value > shapeValue(cards, family) + 0.3) return melds[0].op;
  if (options.some(o => o.type === 1)) return { ...options.find(o => o.type === 1) };
  if (!options.some(o => o.type === 2) && options.some(o => o.type === 7)) return { type: 7 };
  return { type: 2, card: discards[0]?.card };
}

export const thinkTime = (rng = Math.random) => 700 + Math.floor(rng() * 1500);
export function chooseQue(cards) {
  return [1, 2, 3].map(type => ({ type, value: shapeValue(cards.filter(c => suit(c) !== type), 'hzxl')
    - cards.filter(c => suit(c) === type).length * 0.15 })).sort((a, b) => b.value - a.value || a.type - b.type)[0].type;
}
export function chooseExchange(cards) {
  const same = [1, 2, 3].map(s => cards.filter(c => suit(c) === s)).filter(a => a.length >= 3).sort((a, b) => a.length - b.length);
  let best = [], score = -Infinity;
  for (const group of same) for (let a = 0; a < group.length - 2; a++) for (let b = a + 1; b < group.length - 1; b++) for (let c = b + 1; c < group.length; c++) {
    const picked = [group[a], group[b], group[c]], rest = cards.slice();
    for (const card of picked) rest.splice(rest.indexOf(card), 1);
    const value = shapeValue(rest, 'hzxl');
    if (value > score) { score = value; best = picked; }
  }
  return best;
}
// Input deliberately contains only this player's tiles and public discards.
export function chooseAction(input, rng = Math.random) {
  if (input.context) return informedAction(input, rng);
  const { cards, options, queType = 0, ting = false, drawn, family, publicCards = [] } = input;
  const preferred = [8, 10, 11, 4, 5, 6, 16, 3, 12, 9, 1];
  for (const type of preferred) {
    const op = options.find(o => o.type === type);
    if (op) return { ...op, ...(type === 12 ? { chiUseCards: op.cards[0] } : {}) };
  }
  if (options.some(o => o.type === 7) && !options.some(o => o.type === 2)) return { type: 7 };
  if (ting && drawn != null && cards.includes(drawn)) return { type: 2, card: drawn };
  const c = counts(cards), visible = counts(publicCards), missingSuit = cards.filter(c => suit(c) === queType);
  const allowed = missingSuit.length ? missingSuit : cards;
  const ranked = [...new Set(allowed)].map(t => {
    let keep = (c[t] - 1) * 3.5;
    if (family === 'hzxl' && t === 27) keep += 15;
    if (t < 27) for (const delta of [-2, -1, 1, 2]) {
      const other = t + delta;
      if (other >= 0 && other < 27 && suit(other) === suit(t)) keep += c[other] * (Math.abs(delta) === 1 ? 1.3 : .6);
    }
    keep -= visible[t] * .25;
    return { card: t, keep: keep + rng() * .5 };
  }).sort((a, b) => a.keep - b.keep || a.card - b.card);
  return { type: 2, card: ranked[0]?.card };
}
