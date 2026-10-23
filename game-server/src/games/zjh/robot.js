import gameConfig from "./config.js";
import { evaluate3 } from "./hand.js";
import { ZJH_OP } from "./messages.js";

const BOT_UID = 90000002;
const BOT_NAME = "Bot";
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const action = (operation, operationData = 0) => ({ operation, operationData });

export function ensureBot(table) {
  if (table.members.filter((member) => !member.bot).length !== 1 || table.members.some((member) => member.bot)) return;
  const used = new Set(table.members.map((member) => member.pos));
  const pos = Array.from({ length: gameConfig.maxPeople }, (_, index) => index).find((index) => !used.has(index));
  if (pos == null) return;
  let uid = BOT_UID;
  while (table.members.some((member) => member.uid === uid)) uid += 1;
  table.members.push({
    uid, name: BOT_NAME,
    point: Math.max(finite(table.carryMin), finite(table.ante, gameConfig.defaultAnte) * gameConfig.buyInMultiple),
    pos, state: 1, lastOperation: 0, totalBet: 0, streetBet: 0, dealer: false, bot: true,
  });
}

export function botChoose(table, actor, rng = Math.random) {
  const hand = table.hand;
  const ante = Math.max(1, finite(table.ante, gameConfig.defaultAnte));
  const stack = Math.max(0, finite(actor.point));
  const call = Math.min(stack, Math.max(ante, finite(hand.currentBet) - finite(actor.streetBet)));
  if (!stack) return action(ZJH_OP.COMPARE);
  // A blind player has not seen its own hand. Occasionally play a cheap blind
  // call; otherwise LOOK first and let the next scheduled decision evaluate it.
  if (!actor.looked) {
    return action(hand.round === 1 && call <= ante * 2 && stack > ante * 12 && rng() < 0.15
      ? ZJH_OP.CALL : ZJH_OP.LOOK);
  }
  if (actor.hole?.length !== 3 || new Set(actor.hole).size !== 3
    || !actor.hole.every((card) => Number.isInteger(card) && card >= 0 && card < 52)) return action(ZJH_OP.FOLD);
  const rank = evaluate3(actor.hole);
  const strength = rank.cardTypeId >= 3 ? [0, 0, 0, 0.86, 0.93, 0.98, 0.995][rank.cardTypeId]
    : rank.cardTypeId === 2 ? 0.6 + (rank.key[0] - 2) * 0.02
      : 0.1 + (rank.key[0] - 2) * 0.035 + (rank.key[1] - 2) * 0.01;
  const rivals = table.members.filter((member) => member.uid !== actor.uid && !member.folded && member.totalBet > 0);
  const equity = Math.pow(strength, Math.max(1, rivals.length));
  const pot = Math.max(ante, finite(hand.pot));
  const looseness = (Math.abs(finite(actor.uid)) % 3 - 1) * 0.025;
  if (equity + looseness < call / (pot + call) + 0.07 + 0.12 * call / stack) return action(ZJH_OP.FOLD);
  if (rivals.length && strength > 0.7 && (hand.round >= 3 || stack <= call * 3) && rng() < 0.35) {
    return action(ZJH_OP.COMPARE, rivals[Math.floor(rng() * rivals.length)].uid);
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
    applyAction(actor.uid, choice.operation, choice.operationData);
  }
  return true;
}
