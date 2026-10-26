import { rel } from "../../rel.js";
const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { default: gameConfig } = await rel(import.meta.url, "./config.js", version);
const { evaluate3 } = await rel(import.meta.url, "./hand.js", version);
const { ZJH_OP } = await rel(import.meta.url, "./messages.js", version);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const action = (operation, operationData) => ({ operation, ...(operationData == null ? {} : { operationData }) });

export function botChoose(table, actor, rng = Math.random) {
  const hand = table.hand;
  const ante = Math.max(1, finite(table.ante, gameConfig.defaultAnte));
  const stack = Math.max(0, finite(actor.point));
  const cost = Math.max(ante, finite(hand.currentBet)) * (actor.looked ? 2 : 1);
  const call = Math.min(stack, cost);
  if (!stack) return action(ZJH_OP.FOLD);
  // A blind player has not seen its own hand. Occasionally play a cheap blind
  // call; otherwise LOOK first and let the next scheduled decision evaluate it.
  if (!actor.looked) {
    if (hand.round <= 1) return action(stack < cost ? ZJH_OP.ALL_IN : ZJH_OP.CALL);
    return action(call <= ante * 2 && stack > ante * 12 && rng() < 0.15
      ? ZJH_OP.CALL : ZJH_OP.LOOK);
  }
  if (actor.hole?.length !== 3 || new Set(actor.hole).size !== 3
    || !actor.hole.every((card) => Number.isInteger(card) && card >= 0 && card < 52)) return action(ZJH_OP.FOLD);
  const rank = evaluate3(actor.hole);
  const strength = rank.cardTypeId >= 3 ? [0, 0, 0, 0.86, 0.93, 0.98, 0.995][rank.cardTypeId]
    : rank.cardTypeId === 2 ? 0.6 + (rank.key[0] - 2) * 0.02
      : 0.1 + (rank.key[0] - 2) * 0.035 + (rank.key[1] - 2) * 0.01;
  const rivals = (hand.participants || table.members).filter((member) => member.uid !== actor.uid && !member.folded && member.totalBet > 0);
  const equity = Math.pow(strength, Math.max(1, rivals.length));
  const pot = Math.max(ante, finite(hand.pot));
  const looseness = (Math.abs(finite(actor.uid)) % 3 - 1) * 0.025;
  if (equity + looseness < call / (pot + call) + 0.07 + 0.12 * call / stack) return action(ZJH_OP.FOLD);
  if (stack < cost) return action(ZJH_OP.ALL_IN);
  if (rivals.length && hand.round > 1 && stack >= cost * 2 && strength > 0.7
    && (hand.round >= 3 || stack <= call * 3) && rng() < 0.35) {
    return { operation: ZJH_OP.COMPARE, targetUid: rivals[Math.floor(rng() * rivals.length)].uid };
  }
  if (strength > 0.7 && stack >= call * 3 && rng() < 0.4) return action(ZJH_OP.RAISE);
  return action(ZJH_OP.CALL);
}

export function scheduleTurn(table, actor, now = Date.now(), rng = Math.random) {
  if (!actor.bot) { table.hand.botActAt = 0; return; }
  const delay = 600 + Math.floor(rng() * 1700);
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
