import { rel } from "../../rel.js";
const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { default: gameConfig } = await rel(import.meta.url, "./config.js", version);
const { evaluate3, compareWithSuit } = await rel(import.meta.url, "./hand.js", version);
const { ZJH_OP } = await rel(import.meta.url, "./messages.js", version);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const action = (operation, operationData) => ({ operation, ...(operationData == null ? {} : { operationData }) });
const SAMPLES = 96;
const estimates = new WeakMap();
const styles = [
  { looseness: -0.02, aggression: 0.45, trap: 0.18, bluff: 0.025 },
  { looseness: 0, aggression: 0.55, trap: 0.25, bluff: 0.04 },
  { looseness: 0.025, aggression: 0.65, trap: 0.15, bluff: 0.06 },
];
const validCards = (cards, count) => Array.isArray(cards) && cards.length === count
  && new Set(cards).size === count && cards.every((card) => Number.isInteger(card) && card >= 0 && card < 52);

function visibleCards(table, actor) {
  if (actor.looked) return validCards(actor.hole, 3) ? actor.hole.slice() : null;
  const count = table.playMode === 2 ? 2 : table.playMode === 5 ? 1 : 0;
  // Ordinary blind play must not even access the hole property. Partial-open
  // play reads only the initially visible slots, never the remaining cards.
  if (!count) return [];
  const cards = Array.isArray(actor.hole) ? actor.hole.slice(0, count) : null;
  return validCards(cards, count) ? cards : null;
}

function estimateHands(hand, actor, visible, rivals) {
  const known = new Set(visible);
  const holdings = rivals.map((rival) => {
    if (rival.bot) return null;
    const cards = rival.hole;
    if (!validCards(cards, 3) || cards.some((card) => known.has(card))) return null;
    cards.forEach((card) => known.add(card));
    return cards.slice();
  });
  const key = JSON.stringify([visible, rivals.map((rival, i) => [rival.uid, holdings[i]])]);
  let cache = estimates.get(hand);
  if (!cache) estimates.set(hand, cache = new Map());
  const cached = cache.get(actor.uid);
  if (cached?.key === key) return cached.value;
  const own = visible.length === 3 ? evaluate3(visible) : null;
  const ranked = holdings.map((cards) => cards ? evaluate3(cards) : null);
  const exact = Boolean(own && ranked.every(Boolean));
  const samples = exact ? 1 : SAMPLES;
  const unknown = Array.from({ length: 52 }, (_, card) => card).filter((card) => !known.has(card));
  let seed = 2166136261;
  for (const char of key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let won = 0;
  const duels = rivals.map(() => 0);
  const outcomes = [];
  for (let trial = 0; trial < samples; trial += 1) {
    const pool = unknown.slice();
    let next = 0;
    const draw = () => {
      const index = next + Math.floor(random() * (pool.length - next));
      [pool[next], pool[index]] = [pool[index], pool[next]];
      return pool[next++];
    };
    const cards = visible.slice();
    while (cards.length < 3) cards.push(draw());
    const ownRank = own || evaluate3(cards);
    const wins = rivals.map((rival, i) => {
      const rank = ranked[i] || evaluate3([draw(), draw(), draw()]);
      // The engine's compareRule=1 uses suit to break equal ranks. Initiating
      // an exactly tied comparison loses, so only a strict win has value.
      const wins = compareWithSuit(ownRank, rank) > 0;
      if (wins) duels[i] += 1;
      return wins;
    });
    if (wins.every(Boolean)) won += 1;
    outcomes.push(wins);
  }
  const value = { equity: won / samples, duels: duels.map((wins) => wins / samples),
    ranked, own, exact, outcomes, informed: holdings.some(Boolean) };
  cache.set(actor.uid, { key, value });
  return value;
}

function callValue(table, actor, rivals, estimate, call) {
  const players = table.hand.participants || table.members;
  const pot = Math.max(0, finite(table.hand.pot));
  // Normal Zjh pots are winner-takes-all. Contribution layers apply only when
  // a short stack goes all-in, just as in the shared settlement path.
  if (call === actor.point
    || players.some((player) => !player.folded && player.point === 0)) {
    const cap = finite(actor.totalBet) + call;
    const contributions = players.map((player) => ({ player,
      amount: Math.min(cap, Math.max(0, finite(player.totalBet)) + (player.uid === actor.uid ? call : 0)) }));
    const levels = [...new Set(contributions.map((entry) => entry.amount).filter((amount) => amount > 0))].sort((a, b) => a - b);
    let previous = 0, expected = 0;
    for (const level of levels) {
      const contributors = contributions.filter((entry) => entry.amount >= level);
      const amount = (level - previous) * contributors.length;
      previous = level;
      const opponents = rivals.map((rival, i) => contributors.some((entry) => entry.player.uid === rival.uid) ? i : -1)
        .filter((i) => i >= 0);
      const chance = estimate.outcomes.filter((wins) => opponents.every((i) => wins[i])).length / estimate.outcomes.length;
      expected += amount * chance;
    }
    return expected - call;
  }
  return estimate.equity * (pot + call) - call;
}

export function botChoose(table, actor, rng = Math.random) {
  const hand = table.hand;
  if (!hand) return action(ZJH_OP.FOLD);
  const ante = Math.max(1, finite(table.ante, gameConfig.defaultAnte));
  const stack = Math.max(0, finite(actor.point));
  const cost = Math.max(ante, finite(hand.currentBet)) * (actor.looked ? 2 : 1);
  const call = Math.min(stack, cost);
  if (!stack) return action(ZJH_OP.FOLD);
  const visible = visibleCards(table, actor);
  if (!visible) return action(ZJH_OP.FOLD);
  const rivals = (hand.participants || table.members).filter((member) => member.uid !== actor.uid && !member.folded && member.totalBet > 0);
  if (!rivals.length) return action(ZJH_OP.FOLD);
  const estimate = estimateHands(hand, actor, visible, rivals);
  const style = styles[Math.abs(Math.trunc(finite(actor.uid))) % styles.length];
  const pot = Math.max(ante, finite(hand.pot));
  const value = callValue(table, actor, rivals, estimate, call);
  // Seeing cards is free but doubles later betting costs. Keep occasional
  // inexpensive blind calls; expensive decisions first buy information legally.
  if (!actor.looked) {
    const cheap = cost <= ante * 2 && stack >= cost * 6;
    if (hand.round > 1) return action(cheap && estimate.equity > 0.2 && rng() < 0.15
      ? ZJH_OP.CALL : ZJH_OP.LOOK);
    if ((estimate.informed && estimate.equity < 0.06) || (!cheap && value < 0)) return action(ZJH_OP.FOLD);
    return action(stack < cost ? ZJH_OP.ALL_IN : ZJH_OP.CALL);
  }
  const pressure = rivals.filter((rival, i) => !estimate.ranked[i] && rival.looked).length * 0.025
    + (rivals.some((rival, i) => !estimate.ranked[i] && rival.lastOperation === ZJH_OP.RAISE) ? 0.04 : 0);
  const late = rivals.every((rival) => rival.point <= 0 || hand.acted?.has(rival.uid));
  const margin = estimate.exact ? 0 : 0.03 + 0.08 * call / stack + pressure - style.looseness - (late ? 0.02 : 0);
  const profitable = value >= margin * (pot + call);
  if (!profitable) {
    // Bluff sparingly into a weak, seen human hand. Never bluff an all-in player
    // or commit most of the stack with a hand known to be losing.
    const bluffable = rivals.length === 1 && rivals[0].point > cost * 2 && rivals[0].looked
      && estimate.ranked[0]?.cardTypeId === 1 && estimate.ranked[0].key[0] <= 12;
    if (bluffable && late && stack >= cost * 8 && rng() < style.bluff) return action(ZJH_OP.RAISE);
    return action(ZJH_OP.FOLD);
  }
  if (stack < cost) return action(ZJH_OP.ALL_IN);
  // Remove a dangerous opponent we can beat, rather than choosing randomly.
  const targets = rivals.map((rival, i) => ({ rival, chance: estimate.duels[i], rank: estimate.ranked[i] }))
    .filter((target) => target.rival.point > 0 && target.chance >= 0.72)
    .sort((a, b) => a.rank && b.rank ? compareWithSuit(b.rank, a.rank)
      : a.chance - b.chance || Number(b.rival.looked) - Number(a.rival.looked));
  const compareChance = hand.round >= finite(table.maxRounds, gameConfig.maxRounds) - 1 ? 0.65
    : stack <= cost * 3 ? 0.55 : 0.3;
  if (targets.length && hand.round > 1 && stack >= cost * 2 && hand.round >= 3 && rng() < compareChance) {
    return { operation: ZJH_OP.COMPARE, targetUid: targets[0].rival.uid };
  }
  const canRaise = stack >= cost * 3 && rivals.some((rival) => rival.point >= cost);
  const valueRaise = estimate.equity >= Math.max(0.6, 1 / (rivals.length + 1) + 0.2);
  const trap = estimate.exact && rivals.some((rival) => !rival.looked) ? style.trap : 0;
  if (canRaise && valueRaise && rng() < style.aggression - trap) return action(ZJH_OP.RAISE);
  return action(ZJH_OP.CALL);
}

export function scheduleTurn(table, actor, now = Date.now(), rng = Math.random) {
  if (!actor.bot) { table.hand.botActAt = 0; return; }
  const delay = 600 + Math.floor(rng() * 1700)
    + (actor.looked && table.hand.currentBet * 2 > finite(actor.point) * 0.2 ? 350 : 0);
  const deadline = finite(table.hand.deadline, now + finite(table.betTime, gameConfig.betTime) * 1000);
  table.hand.botActAt = now + Math.max(0, Math.min(delay, deadline - now - 100));
}

export function tickBot(table, actor, now, applyAction, rng = Math.random) {
  if (!actor.bot) return false;
  if (now >= (table.hand.botActAt || 0)) {
    const choice = botChoose(table, actor, rng);
    applyAction(actor.uid, choice.operation, choice.operationData, choice.targetUid);
  }
  return true;
}
