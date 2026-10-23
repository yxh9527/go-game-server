import gameConfig from "./config.js";
import { compareRank, evaluate7, makeDeck, rankValue } from "./cards.js";
import { OP } from "./op.js";

export const BOT_UID = 90000001;
const BOT_NAME = "Bot";
const EQUITY_SAMPLES = 64;
// Weak keys let completed hands (including their cached estimates) be collected.
const estimates = new WeakMap();
const styles = [
  { looseness: -0.025, aggression: 0.45, bluff: 0.025 },
  { looseness: 0, aggression: 0.55, bluff: 0.04 },
  { looseness: 0.035, aggression: 0.65, bluff: 0.065 },
];
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const action = (operation, operationData = 0) => ({ operation, operationData });

export function ensureBots(table, count, rng = Math.random) {
  const maxPeople = gameConfig.maxPeople;
  if (table.botTarget == null) {
    const target = count == null ? 3 + Math.floor(rng() * 4) : finite(count);
    table.botTarget = clamp(Math.floor(target), 0, maxPeople - 1);
  }
  const usedPositions = new Set(table.members.map((member) => member.pos));
  const usedIds = new Set(table.members.map((member) => member.uid));
  const point = Math.max(finite(table.carryMin), finite(table.bigBlind, gameConfig.defaultBigBlind) * gameConfig.buyInBb);
  let countNow = table.members.filter((member) => member.bot).length;
  while (countNow < table.botTarget && table.members.length < maxPeople) {
    const pos = Array.from({ length: maxPeople }, (_, index) => index).find((index) => !usedPositions.has(index));
    if (pos == null) break;
    let uid = BOT_UID;
    while (usedIds.has(uid)) uid += 1;
    table.members.push({
      uid, name: uid === BOT_UID ? BOT_NAME : BOT_NAME + (uid - BOT_UID + 1),
      point, pos, state: 1, lastOperation: 0, totalBet: 0, streetBet: 0,
      dealer: false, bot: true, clubId: 0,
    });
    usedPositions.add(pos);
    usedIds.add(uid);
    countNow += 1;
  }
}

export const ensureBot = ensureBots;

function preflopStrength(hole) {
  const [high, low] = hole.map(rankValue).sort((a, b) => b - a);
  if (high === low) return 0.48 + (high - 2) * 0.04;
  const gap = high - low;
  const suited = Math.floor(hole[0] / 13) === Math.floor(hole[1] / 13);
  return clamp(0.12 + (high - 2) * 0.025 + (low - 2) * 0.015
    + (suited ? 0.08 : 0) + (gap === 1 ? 0.07 : gap === 2 ? 0.04 : gap >= 5 ? -0.06 : 0)
    + (high === 14 ? 0.04 : 0) + (low >= 10 ? 0.08 : 0), 0, 1);
}

function publicOpponents(table, actor) {
  // Contributions/all-in status are public. Do not inspect other players' holes,
  // even their length: unfunded or newly seated players are not in this hand.
  return table.members.filter((member) => member.uid !== actor.uid && !member.folded
    && (member.totalBet > 0 || member.streetBet > 0 || member.allIn));
}

function equity(hand, actor, board, opponents) {
  const key = [...actor.hole, ...board, opponents].join(",");
  let cache = estimates.get(hand);
  if (!cache) estimates.set(hand, cache = new Map());
  const cached = cache.get(actor.uid);
  if (cached?.key === key) return cached.value;

  // Sample only unknown cards from a fresh deck, never the engine's shuffled
  // deck, undealt board or opponents' actual hole cards. One estimate per public
  // state keeps repeat raises inexpensive and avoids random opinion changes.
  const known = new Set([...actor.hole, ...board]);
  const unknown = makeDeck().filter((card) => !known.has(card));
  let seed = 2166136261;
  for (const ch of key) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let won = 0;
  for (let trial = 0; trial < EQUITY_SAMPLES; trial += 1) {
    const pool = unknown.slice();
    let next = 0;
    const draw = () => {
      const index = next + Math.floor(random() * (pool.length - next));
      [pool[next], pool[index]] = [pool[index], pool[next]];
      return pool[next++];
    };
    const runout = board.slice();
    while (runout.length < 5) runout.push(draw());
    const own = evaluate7([...actor.hole, ...runout]);
    let ties = 1;
    let beaten = false;
    for (let rival = 0; rival < opponents; rival += 1) {
      const result = compareRank(own, evaluate7([draw(), draw(), ...runout]));
      if (result < 0) { beaten = true; break; }
      if (result === 0) ties += 1;
    }
    if (!beaten) won += 1 / ties;
  }
  const value = won / EQUITY_SAMPLES;
  cache.set(actor.uid, { key, value });
  return value;
}

export function botChoose(table, actor, rng = Math.random) {
  const hand = table.hand;
  const streetBet = Math.max(0, finite(actor.streetBet));
  const stack = Math.max(0, finite(actor.point));
  const currentBet = Math.max(0, finite(hand?.currentBet));
  const toCall = Math.max(0, currentBet - streetBet);
  const safe = () => action(toCall === 0 ? OP.PASS : OP.ABANDON);
  const board = hand?.board || [];
  const hole = actor.hole || [];
  if (!hand || !stack || hole.length !== 2 || ![0, 3, 4, 5].includes(board.length)
    || ![...hole, ...board].every((card) => Number.isInteger(card) && card >= 0 && card < 52)
    || new Set([...hole, ...board]).size !== hole.length + board.length) return safe();

  const rivals = publicOpponents(table, actor);
  const opponents = Math.max(1, rivals.length);
  const style = styles[Math.abs(Math.trunc(finite(actor.uid))) % styles.length];
  const bb = Math.max(1, finite(table.bigBlind, gameConfig.defaultBigBlind));
  const preflop = board.length === 0;
  const strength = preflop ? preflopStrength(hole) : 0;
  const estimatedEquity = preflop
    ? Math.pow(0.27 + strength * 0.6, 1 + (opponents - 1) * 0.65)
    : equity(hand, actor, board, opponents);
  const call = Math.min(toCall, stack);
  // A short stack cannot win portions of side pots above its own contribution.
  const eligiblePot = table.members.reduce((sum, member) =>
    sum + Math.min(Math.max(0, finite(member.totalBet)), finite(actor.totalBet) + call), 0);
  const pot = Math.max(bb, Math.min(finite(hand.pot, bb), eligiblePot || finite(hand.pot, bb)));
  const price = call / (pot + call);
  // The sample is against unknown holdings, while a player committing chips
  // represents a stronger range. Apply a price-sensitive discount rather than
  // treating an ace-high draw like a made hand against a large bet.
  const rangeDiscount = !preflop && toCall > 0 ? 0.04 + 0.12 * price : 0;
  const winChance = Math.max(0, estimatedEquity - rangeDiscount);
  const late = actor.dealer || rivals.every((member) => member.allIn || hand.acted?.has(member.uid));
  const margin = 0.025 + 0.1 * (call / stack) + 0.07 * Math.min(1, toCall / pot);
  const adjusted = winChance + style.looseness + (preflop && late ? 0.025 : 0);
  if (toCall > 0 && adjusted + (rng() - 0.5) * 0.025 < price + margin) return action(OP.ABANDON);

  const minRaise = Math.max(bb, finite(hand.minRaise, bb));
  const contestable = Math.max(currentBet, ...rivals.filter((member) => !member.allIn)
    .map((member) => finite(member.streetBet) + finite(member.point)));
  const maxTarget = Math.min(streetBet + stack, contestable);
  const canRaise = stack > toCall && maxTarget >= currentBet + minRaise;
  const valueRaise = preflop
    ? strength >= (currentBet > 4 * bb ? 0.86 : 0.7)
    : winChance >= Math.max(0.55, 1 / (opponents + 1) + 0.22);
  const semiBluff = !preflop && board.length < 5 && winChance > 0.25;
  const bluffChance = toCall === 0 && opponents <= 2 && late
    ? style.bluff + (semiBluff ? 0.08 : 0) : 0;
  if (canRaise && rng() < (valueRaise ? style.aggression : bluffChance)) {
    const increment = preflop
      ? (currentBet <= bb ? bb * (2 + rng()) : currentBet * (1 + 0.4 * rng()))
      : (pot + call) * (0.4 + rng() * 0.35);
    const target = Math.min(maxTarget, Math.max(currentBet + minRaise, Math.round(currentBet + increment)));
    // Avoid gambling most of a deep stack with a marginal made hand/draw.
    if (target - streetBet <= stack * 0.5 || winChance >= 0.72) {
      if (target >= streetBet + stack) return action(OP.ALL_IN);
      // The same action path as real players expects a total street target in
      // display currency; raiseAmount converts it back to internal cents.
      return action(currentBet === 0 ? OP.BET : OP.ADD, target / 100);
    }
  }
  if (toCall === 0) return action(OP.PASS);
  return call === stack ? action(OP.ALL_IN) : action(OP.FOLLOW, call);
}

export function scheduleTurn(table, actor, now = Date.now(), rng = Math.random) {
  if (!actor.bot) { table.hand.botActAt = 0; return; }
  const facingBet = table.hand.currentBet > finite(actor.streetBet);
  const delay = 650 + Math.floor(rng() * 1500) + (facingBet ? 450 : 0);
  const deadline = finite(table.hand.deadline, now + finite(table.betTime, gameConfig.betTime) * 1000);
  table.hand.botActAt = now + Math.max(0, Math.min(delay, deadline - now - 100));
}

export function tickBot(table, actor, now, applyAction, rng = Math.random) {
  if (!actor.bot) return false;
  if (now >= (table.hand.botActAt || 0)) {
    const choice = botChoose(table, actor, rng);
    applyAction(actor.uid, choice.operation, choice.operationData);
  }
  return true;
}
