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
  const usedIds = new Set([...table.members, ...(table.observers || [])].map((member) => member.uid));
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
    + (high === 14 ? 0.04 : 0) + (low >= 10 ? 0.08 : 0)
    + (suited && high === 14 && low <= 5 ? 0.05 : 0), 0, 1);
}

// A made hand's name alone is misleading: a pair on the board is not a pair
// in our hole cards, and four suited board cards can make an overpair fragile.
export function assessHand(hole, board) {
  if (!board.length) return { preflop: preflopStrength(hole) };
  const known = [...hole, ...board];
  const made = evaluate7(known);
  const boardRanks = board.map(rankValue);
  const holeRanks = hole.map(rankValue);
  const suits = Array.from({ length: 4 }, (_, suit) => board.filter((card) => Math.floor(card / 13) === suit).length);
  const boardValues = new Set(boardRanks);
  if (boardValues.has(14)) boardValues.add(1);
  let connected = 0;
  for (let low = 1; low <= 10; low += 1) {
    connected = Math.max(connected, Array.from({ length: 5 }, (_, i) => low + i)
      .filter((value) => boardValues.has(value)).length);
  }
  const playsBoard = board.length === 5 && compareRank(made, evaluate7(board)) === 0;
  let quality = "air";
  if (made.cardTypeId >= 5) quality = "strong";
  else if (made.cardTypeId === 4) quality = "trips";
  else if (made.cardTypeId === 3) quality = "two-pair";
  else if (made.cardTypeId === 2) {
    const pair = made.key[0];
    if (!holeRanks.includes(pair)) quality = "air";
    else if (holeRanks[0] === holeRanks[1] && pair > Math.max(...boardRanks)) quality = "overpair";
    else if (pair === Math.max(...boardRanks)) quality = "top-pair";
    else quality = "weak-pair";
  }
  // Board pairs/trips must not turn a low pocket pair or a kicker into value.
  if (board.length >= 3) {
    const counts = boardRanks.map((rank) => boardRanks.filter((other) => other === rank).length);
    if (made.cardTypeId === 4 && counts.includes(3)) quality = "weak-pair";
    if (made.cardTypeId === 3 && !holeRanks.some((rank) => boardRanks.includes(rank))) quality = "weak-pair";
  }
  if (playsBoard) quality = "board";

  const flushOuts = new Set();
  const straightOuts = new Set();
  if (board.length < 5) {
    const values = new Set(known.map(rankValue));
    if (values.has(14)) values.add(1);
    for (const card of makeDeck()) {
      if (known.includes(card)) continue;
      const suit = Math.floor(card / 13);
      if (made.cardTypeId < 6 && known.filter((c) => Math.floor(c / 13) === suit).length === 4
        && hole.some((c) => Math.floor(c / 13) === suit)) flushOuts.add(card);
      if (made.cardTypeId >= 5) continue;
      const rank = rankValue(card);
      for (let low = 1; low <= 10; low += 1) {
        const window = Array.from({ length: 5 }, (_, i) => low + i);
        if (window.every((v) => values.has(v) || v === rank || (v === 1 && rank === 14))
          && window.some((v) => holeRanks.includes(v === 1 ? 14 : v) && !boardValues.has(v))) {
          straightOuts.add(card);
        }
      }
    }
  }
  return {
    made: made.name, quality, playsBoard,
    // These are potential improvement cards, not guaranteed winning outs.
    flushDraw: flushOuts.size > 0, straightDraw: straightOuts.size > 0,
    drawOuts: new Set([...flushOuts, ...straightOuts]).size,
    wet: Math.max(...suits) >= 2 || connected >= 3,
    dangerous: Math.max(...suits) >= 4 || connected >= 4,
  };
}

function participants(table) {
  return table.hand.participants || table.members;
}

function publicOpponents(table, actor) {
  // Select this hand's live opponents before looking at any cards. Empty seats,
  // folded players and players joining mid-hand are not decision inputs.
  return participants(table).filter((member) => member.uid !== actor.uid && !member.folded
    && (member.totalBet > 0 || member.streetBet > 0 || member.allIn));
}

function latePosition(table, actor, rivals, preflop) {
  const active = [actor, ...rivals.filter((member) => !member.allIn && member.point > 0)]
    .sort((a, b) => a.pos - b.pos);
  const anchorUid = preflop ? table.hand.bigBlindId : table.hand.bankerId;
  const order = participants(table).slice().sort((a, b) => a.pos - b.pos);
  const anchor = order.findIndex((member) => member.uid === anchorUid);
  if (anchor < 0) return rivals.every((member) => member.allIn || table.hand.acted?.has(member.uid));
  const distance = (member) => (order.findIndex((p) => p.uid === member.uid) - anchor - 1 + order.length) % order.length;
  const behind = active.filter((member) => distance(member) > distance(actor)).length;
  return preflop ? behind <= Math.floor((active.length - 1) / 3) : behind === 0;
}

function equity(hand, actor, board, rivals) {
  const known = new Set([...actor.hole, ...board]);
  const holdings = rivals.map((rival) => {
    // Explicit Holdem policy: human holes are available to robot decisions.
    // Other robots' holes and the engine's deck remain outside this policy.
    if (rival.bot) return null;
    const hole = rival.hole;
    if (!Array.isArray(hole) || hole.length !== 2 || hole[0] === hole[1]
      || !hole.every((card) => Number.isInteger(card) && card >= 0 && card < 52 && !known.has(card))) return null;
    hole.forEach((card) => known.add(card));
    return hole.slice();
  });
  const allKnown = holdings.length > 0 && holdings.every(Boolean);
  const knownHumans = holdings.some(Boolean);
  if (!board.length && !knownHumans) return { allKnown, knownHumans, exact: false };
  const exact = board.length === 5 && allKnown;
  const key = knownHumans ? JSON.stringify([actor.hole, board, holdings])
    : [...actor.hole, ...board, Math.max(1, holdings.length)].join(",");
  let cache = estimates.get(hand);
  if (!cache) estimates.set(hand, cache = new Map());
  const cached = cache.get(actor.uid);
  if (cached?.key === key) return cached.value;

  // Human holes are fixed in every trial and excluded from future runouts.
  // Future board cards and unknown bot holes come from an independent deck.
  const unknown = makeDeck().filter((card) => !known.has(card));
  let seed = 2166136261;
  for (const ch of key) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let won = 0;
  let outright = 0;
  const samples = exact ? 1 : EQUITY_SAMPLES;
  for (let trial = 0; trial < samples; trial += 1) {
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
    for (const holding of holdings.length ? holdings : [null]) {
      const result = compareRank(own, evaluate7([...(holding || [draw(), draw()]), ...runout]));
      if (result < 0) { beaten = true; break; }
      if (result === 0) ties += 1;
    }
    if (!beaten) {
      won += 1 / ties;
      if (ties === 1) outright += 1;
    }
  }
  const value = { share: won / samples, win: outright / samples, allKnown, knownHumans, exact,
    weakRivals: board.length >= 3 && allKnown && holdings.every((hole) =>
      ["air", "weak-pair"].includes(assessHand(hole, board).quality)) };
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
  const holding = assessHand(hole, board);
  const strength = holding.preflop || 0;
  const estimate = equity(hand, actor, board, rivals);
  const estimatedEquity = preflop && !estimate.knownHumans
    ? Math.pow(0.27 + strength * 0.6, 1 + (opponents - 1) * 0.65)
    : estimate.share;
  const call = Math.min(toCall, stack);
  // A short stack cannot win portions of side pots above its own contribution.
  const eligiblePot = participants(table).reduce((sum, member) =>
    sum + Math.min(Math.max(0, finite(member.totalBet)), finite(actor.totalBet) + call), 0);
  const pot = Math.max(bb, Math.min(finite(hand.pot, bb), eligiblePot || finite(hand.pot, bb)));
  const price = call / (pot + call);
  // A range discount applies only when some opponents' holdings are unknown.
  const marginal = ["air", "weak-pair", "top-pair", "overpair", "board"].includes(holding.quality);
  const rangeDiscount = !estimate.allKnown && !preflop && toCall > 0
    ? 0.04 + 0.12 * price + (holding.dangerous && marginal ? 0.1 : 0) : 0;
  const winChance = Math.max(0, estimatedEquity - rangeDiscount);
  const late = latePosition(table, actor, rivals, preflop);
  const margin = 0.025 + 0.1 * (call / stack) + 0.07 * Math.min(1, toCall / pot);
  const adjusted = winChance + style.looseness + (preflop && late ? 0.025 : 0);
  // A royal flush on the board guarantees a split. Risk premiums must never
  // make us surrender a guaranteed share of the eligible pot.
  const guaranteedShare = estimate.exact && estimate.share > 0
    || holding.playsBoard && holding.made === "ROYAL_FLUSH";
  if (toCall > 0 && !guaranteedShare
    && (estimate.exact || adjusted + (rng() - 0.5) * 0.025 < price + margin)) return action(OP.ABANDON);

  const minRaise = Math.max(bb, finite(hand.minRaise, bb));
  const contestable = Math.max(currentBet, ...rivals.filter((member) => !member.allIn)
    .map((member) => finite(member.streetBet) + finite(member.point)));
  const maxTarget = Math.min(streetBet + stack, contestable);
  const canRaise = stack > toCall && maxTarget >= currentBet + minRaise;
  const valueRaise = estimate.allKnown ? estimate.win >= 0.6 : preflop
    ? strength >= (currentBet > 4 * bb ? 0.86 : currentBet <= bb && late ? 0.6 : 0.7)
    : !holding.playsBoard && !["air", "weak-pair"].includes(holding.quality)
      && estimate.win >= 0.45 && winChance >= (holding.dangerous && marginal ? 0.75 : 0.55);
  const semiBluff = !preflop && holding.drawOuts >= 8 && winChance > 0.25;
  const foldable = rivals.every((member) => !member.allIn);
  const bluffChance = opponents <= 2 && late && foldable && !holding.playsBoard
    && (!estimate.allKnown || estimate.weakRivals)
    ? (toCall === 0 ? style.bluff + (semiBluff ? 0.12 : 0)
      : semiBluff && toCall <= pot * 0.2 ? 0.12 : 0) : 0;
  if (canRaise && rng() < (valueRaise ? style.aggression : bluffChance)) {
    const fraction = holding.wet && valueRaise ? 0.65 : marginal && valueRaise ? 0.33 : 0.45;
    const increment = preflop
      ? (currentBet <= bb ? bb * (2 + rng()) : currentBet * (1 + 0.4 * rng()))
      : (pot + call) * (fraction + rng() * 0.2);
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
