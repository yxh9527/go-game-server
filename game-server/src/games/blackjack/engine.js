import { rel } from '../../rel.js';
import { shuffle } from '../holdem/cards.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SEND, PUSH, STATE, ACTION } = await rel(import.meta.url, './messages.js', v);
const cards = await rel(import.meta.url, './hand.js', v);
const robot = await rel(import.meta.url, './robot.js', v);
const casino = await rel(import.meta.url, './casino.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const fair = await rel(import.meta.url, '../../core/fair-code.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/blackjack-history.js', v) : null;
export const gameState = table => table.hand?.state || STATE.NONE;
const player = (table, uid) => table.hand?.players.find(p => p.uid === Number(uid));
const totalBet = p => p.hands.reduce((n, h) => n + h.betAmount, 0);
const handRow = h => ({ ...h, cards: h.cards.slice(), cardCount: h.cards.length, ...cards.evaluate(h.cards, h.splitHand) });
const handResults = p => p.hands.map(h => ({ ...handRow(h), handCards: h.cards.slice(), xiaZhuData: h.betAmount }));
const current = table => table.hand?.players[table.hand.turn];
function spend(io, table, p, amount) {
  const shortfall = Math.max(0, amount - p.member.point);
  if (shortfall > 0) {
    if (!casino.isCasino(table) || !casino.fundWager(io, table, p.member, shortfall)) return false;
    p.member.point += shortfall;
    features.recordCarryIn(table, p.member, shortfall);
  }
  p.member.point -= amount; p.member.totalBet += amount;
  return true;
}
function draw(table) {
  const h = table.hand, index = h.cursor++;
  if (index >= h.deck.length) throw new Error('Blackjack shoe exhausted');
  table.shoe.cursor++;
  h.dealtIndices.push(index);
  return h.deck[index];
}
function newHand(list, bet, splitHand = false) {
  const e = cards.evaluate(list, splitHand);
  return { handIndex: 0, cards: list, betAmount: bet, splitHand, doubled: false, stood: e.pointValue >= 21 || list.length >= 5, score: 0 };
}
function newPlayer(m, actionOrder, now) {
  m.state = 4; m.totalBet = 0;
  return { uid: m.uid, pos: m.pos, bot: m.bot, member: m, name: m.name, icon: m.icon,
    actionOrder, openingPoint: casino.availablePoint(m), hole: [], hands: [], currentHandIndex: 0,
    mainBet: 0, insuranceOperated: false, insuranceAmount: 0, insuranceProfit: 0, actAt: now + robot.thinkTime() };
}
function actions(table, p) {
  const h = table.hand, active = p.hands[p.currentHandIndex];
  if (h.state === STATE.INSURANCE && p.hands.length && !p.insuranceOperated) return [
    ...(Math.floor(p.mainBet / 2) > 0 && casino.availablePoint(p.member) >= Math.floor(p.mainBet / 2) ? ['INSURANCE_BUY'] : []), 'INSURANCE_SKIP'];
  if (h.state !== STATE.PLAYER || current(table) !== p || !active || active.stood) return [];
  return ['HIT', 'STAND', ...(active.cards.length === 2 && casino.availablePoint(p.member) >= active.betAmount ? ['DOUBLE'] : []),
    ...(p.hands.length === 1 && active.cards.length === 2 && casino.availablePoint(p.member) >= active.betAmount
      && cards.cardValue(active.cards[0]) === cards.cardValue(active.cards[1]) ? ['SPLIT'] : [])];
}
function row(table, p) {
  return { uid: p.uid, pos: p.pos, point: casino.availablePoint(p.member), betAmount: totalBet(p), mainBet: p.mainBet,
    pairBet: 0, notPairBet: 0, insuranceOperated: p.insuranceOperated,
    insuranceAmount: p.insuranceAmount, insuranceProfit: p.insuranceProfit,
    stood: p.hands.length > 0 && p.hands.every(h => h.stood), actionOrder: p.actionOrder,
    currentHandIndex: p.currentHandIndex, availableActions: actions(table, p), hands: p.hands.map(handRow) };
}
function actionRow(table, p, actionType, amount = 0) {
  const h = table.hand;
  const result = { round: h.actionList.length + 1, gameState: h.state,
    uid: p?.uid || 0, banker: !p, pos: p?.pos ?? -1, displaySeat: p?.pos ?? -1,
    actionOrder: p?.actionOrder ?? -1, handIndex: p?.currentHandIndex || 0,
    actionType, amount, insuranceAmount: p?.insuranceAmount || 0, insuranceProfit: p?.insuranceProfit || 0,
    point: casino.availablePoint(p?.member), handEndType: p?.hands[p.currentHandIndex]?.stood ? 2 : 0,
    hands: p ? p.hands.map(handRow) : [],
    handResults: p ? handResults(p) : [{ handIndex: 0, handCards: h.dealer.slice(),
      ...cards.evaluate(h.dealer), xiaZhuData: 0, doubled: false, stood: false, splitHand: false, score: 0 }] };
  h.actionList.push(result);
  return result;
}
export function snapshot(table, uid = 0, now = Date.now()) {
  // END clears the native desk after settlement. Sending the settled hand here
  // would restore cards that the client has already collected. Keep the live
  // hand intact until cleanup, but expose no finished-hand data on the wire.
  const h = table.hand?.state === STATE.END ? null : table.hand;
  const reveal = h?.state >= STATE.DEALER, self = h?.players.find(p => p.uid === Number(uid));
  const dealer = h ? reveal ? h.dealer.slice() : h.dealer.length ? [h.dealer[0], -1] : [] : [];
  const e = cards.evaluate(dealer.filter(c => c >= 0));
  const active = h?.state === STATE.PLAYER ? current(table) : null;
  return casino.nativeState(table, { currentInning: table.currentInning, gameState: gameState(table), serverNow: now,
    stateDeadline: h?.deadline || 0, currentActionPlayerId: active?.uid || 0,
    currentActionHandIndex: active?.currentHandIndex || 0,
    currentActionAvailableActions: active ? actions(table, active) : [],
    selfAvailableActions: self ? actions(table, self) : [],
    players: h?.players.map(p => row(table, p)) || [],
    // Only new action events are sent on 4554. Reconnect restores the full log.
    actionList: h?.actionList || [], dealerCards: dealer,
    dealerPointValue: e.pointValue, dealerPointValues: e.pointValues,
    insuranceCollect: h?.state >= STATE.CHECK,
    cutDeck: Boolean(h?.newShoe), cutCardReached: (table.shoe?.cursor || 0) >= (table.shoe?.cutIndex || 262),
    shoeDeckColor: table.shoe?.color || 0, shoeDealCount: table.shoe?.cursor || 0,
    ...(h?.settled ? { settleList: h.results } : {}) }, uid);
}
function emit(io, table, id, payload) {
  if (casino.isCasino(table) && io.forEachPlayer && io.sendUser) {
    io.forEachPlayer(session => {
      const self = table.hand?.players.find(p => p.uid === Number(session.userId));
      const state = casino.nativeState(table, payload, session.userId);
      state.selfAvailableActions = table.hand?.state === STATE.END ? [] : self ? actions(table, self) : [];
      io.sendUser(session.userId, id, state);
    });
  } else io.broadcast(id, payload);
}
function broadcast(io, table, id = PUSH.STATE, action) {
  // All player cards are face up in blackjack; the dealer hole card is masked.
  const state = snapshot(table);
  state.actionList = action ? [action] : [];
  emit(io, table, id, state);
}
export function pushSnapshot(send, table, session) {
  if (table.hand) table.hand.viewers.add(Number(session.userId));
  fair.watchFairHand(table, session.userId);
  send(PUSH.SNAPSHOT, snapshot(table, session.userId));
}
export function begin(io, table, now = Date.now(), deckOverride) {
  if (table.hand) return false;
  const members = table.members.filter(m => casino.availablePoint(m) >= table.ante && !m.carryDeadline && !m.pendingDeparture);
  if (!members.length) { table.phase = 'idle'; return false; }
  const newShoe = !table.shoe || table.shoe.cursor >= table.shoe.cutIndex || table.shoe.cards.length - table.shoe.cursor < 40;
  if (deckOverride || newShoe) table.shoe = { cards: deckOverride?.slice() || shuffle(cards.makeShoe()), cursor: 0,
    cutIndex: 262, color: table.shoe ? 1 - table.shoe.color : 0 };
  table.currentInning++; table.phase = 'playing';
  table.hand = { rules: structuredClone(table.roomRules), state: STATE.BET,
    deadline: now + table.roomRules.betTime * 1000, stateStart: now, newShoe,
    deck: table.shoe.cards.slice(table.shoe.cursor), cursor: 0, dealtIndices: [], dealer: [], players: [],
    turn: 0, settled: false, actionList: [],
    viewers: new Set([...(table.observers || []), ...members].filter(m => !m.bot).map(m => m.uid)) };
  table.hand.players = members.sort((a,b) => a.pos - b.pos).map((m, i) => newPlayer(m, i, now));
  features.beginHandStats(table, table.hand.players);
  // Variable length hands commit the real remaining shoe, without assigning
  // undealt cards to any player. Only actually issued indices are disclosed.
  fair.beginFairHand(io, table, table.hand.players, 0);
  broadcast(io, table);
  return true;
}
export function joinBettingHand(io, table, uid, now = Date.now()) {
  const h = table.hand;
  if (!casino.isCasino(table) || !h || h.settled || h.state !== STATE.BET || now >= h.deadline) return false;
  if (player(table, uid)) return false;
  const m = table.members.find(m => m.uid === Number(uid));
  if (!m || m.carryDeadline || m.pendingDeparture || casino.availablePoint(m) < h.rules.ante) return false;
  h.players.push(newPlayer(m, h.players.length, now));
  h.players.sort((a, b) => a.pos - b.pos).forEach((p, i) => { p.actionOrder = i; });
  features.beginHandStats(table, h.players);
  if (!m.bot) h.viewers.add(m.uid);
  // The committed shoe has no preassigned holes. Adding a bettor before any
  // deal leaves the published commitment and original betting deadline intact.
  fair.watchFairHand(table, m.uid);
  broadcast(io, table);
  return true;
}
export function casinoBetError(table, uid, body = {}, now = Date.now(), automatic = false) {
  const h = table.hand;
  if (!h || h.settled || h.state !== STATE.BET || !automatic && now >= h.deadline) return 'ILLEGAL_OPERATION';
  const p = player(table, uid), m = table.members.find(m => m.uid === Number(uid));
  if (!m || m.carryDeadline || !automatic && m.pendingDeparture || p && p.member !== m
    || body.targetPos !== undefined && body.targetPos !== casino.displaySeat(m.pos)
    || (body.pairAmount ?? 0) !== 0 || (body.notPairAmount ?? 0) !== 0) return 'BET_FAILED';
  const amount = body.betAmount, total = (p?.mainBet || 0) + amount;
  if (!Number.isSafeInteger(amount) || amount < h.rules.ante) return 'BET_FAILED';
  if (!Number.isSafeInteger(total) || total > h.rules.maxBet) return 'BET_OVER_MAX_LIMIT';
  if (amount > casino.availablePoint(m)) return 'CLUB_USER_POINT_NOT_ENOUGH';
  return null;
}
function setPhase(io, table, state, now, duration) {
  table.hand.state = state; table.hand.deadline = now + duration; table.hand.stateStart = now;
  broadcast(io, table);
}
function deal(io, table, now) {
  const h = table.hand;
  // A seated funded player defaults to the minimum bet at the deadline.
  for (const p of h.players) if (!p.mainBet) act(io, table, p.uid, SEND.BET, { betAmount: h.rules.ante }, now, true);
  h.dealer = [draw(table), draw(table)];
  h.state = STATE.DEAL; h.stateStart = now;
  for (const p of h.players) {
    p.hands[0] = newHand([draw(table), draw(table)], p.mainBet);
    p.hole = p.hands[0].cards.slice();
    actionRow(table, p, ACTION.DEAL);
  }
  h.deadline = now + h.rules.dealTime;
  // Initial deal contains the player actions but never the dealer's hole.
  const state = snapshot(table); state.actionList = h.actionList.filter(a => a.actionType === ACTION.DEAL);
  emit(io, table, PUSH.STATE, state);
}
function nextTurn(io, table, now) {
  const h = table.hand;
  for (; h.turn < h.players.length; h.turn++) {
    const p = current(table);
    const index = p.hands.findIndex(hand => !hand.stood);
    if (index < 0) continue;
    p.currentHandIndex = index; p.actAt = now + robot.thinkTime();
    setPhase(io, table, STATE.PLAYER, now, h.rules.operateTime * 1000); return;
  }
  h.state = STATE.DEALER; h.deadline = now + 2000; h.stateStart = now;
  const a = actionRow(table, null, ACTION.DEALER_HOLE);
  broadcast(io, table, PUSH.ACTION, a);
}
function checkDealer(io, table, now) {
  const h = table.hand;
  setPhase(io, table, STATE.CHECK, now, 1400);
  for (const p of h.players) {
    p.insuranceProfit = cards.evaluate(h.dealer).handType === 5 ? p.insuranceAmount * 2 : -p.insuranceAmount;
  }
}
export function act(io, table, uid, id, body = {}, now = Date.now(), automatic = false) {
  const h = table.hand;
  if (id === SEND.BET && casino.isCasino(table)) {
    // Automatic minimum bets execute at the deadline inside deal(), whereas
    // client bets must arrive strictly before that unchanged deadline.
    if (casinoBetError(table, uid, body, now, automatic)) return false;
    if (!player(table, uid)) joinBettingHand(io, table, uid, now);
  }
  const p = player(table, uid);
  if (!h || h.settled || !p || (!automatic && (p.member.pendingDeparture || now >= h.deadline))) return false;
  const autoAction = automatic && (!p.bot || now >= h.deadline || p.member.pendingDeparture);
  if (id === SEND.BET) {
    const amount = body.betAmount;
    // Native casino requests identify the selected display seat and include
    // separate pair/not-pair fields. Never debit one seat for another target.
    if (casino.isCasino(table) && (body.targetPos !== undefined && body.targetPos !== casino.displaySeat(p.pos)
      || (body.pairAmount ?? 0) !== 0 || (body.notPairAmount ?? 0) !== 0)) return false;
    if (h.state !== STATE.BET || !casino.isCasino(table) && p.mainBet || typeof amount !== 'number' || !Number.isSafeInteger(amount)
      || amount < h.rules.ante || p.mainBet + amount > h.rules.maxBet || amount > casino.availablePoint(p.member)) return false;
    if (!spend(io, table, p, amount)) return false;
    p.mainBet += amount; p.hands = [newHand([], p.mainBet)];
    const a = actionRow(table, p, autoAction ? ACTION.AUTO_BET : ACTION.BET, amount);
    broadcast(io, table, PUSH.ACTION, a);
    casino.betResponse(io, table, uid, body, 200);
    casino.seatBetUpdate(io, table, snapshot(table));
    return true;
  }
  if (id === SEND.INSURANCE) {
    if (h.state !== STATE.INSURANCE || p.insuranceOperated || typeof body.buyInsurance !== 'boolean') return false;
    const amount = body.buyInsurance ? Math.floor(p.mainBet / 2) : 0;
    if (amount > casino.availablePoint(p.member) || body.buyInsurance && amount <= 0) return false;
    if (!spend(io, table, p, amount)) return false;
    p.insuranceAmount = amount; p.insuranceOperated = true;
    const a = actionRow(table, p, body.buyInsurance ? ACTION.INSURANCE_BUY
      : autoAction ? ACTION.AUTO_INSURANCE_SKIP : ACTION.INSURANCE_SKIP, amount);
    broadcast(io, table, PUSH.ACTION, a); return true;
  }
  const name = ({ [SEND.HIT]: 'HIT', [SEND.STAND]: 'STAND', [SEND.DOUBLE]: 'DOUBLE', [SEND.SPLIT]: 'SPLIT' })[id];
  if (!actions(table, p).includes(name)) return false;
  const active = p.hands[p.currentHandIndex];
  let type = ACTION[name], amount = 0;
  if (name === 'STAND') { active.stood = true; if (autoAction) type = ACTION.AUTO_STAND; }
  if (name === 'HIT' || name === 'DOUBLE') {
    if (name === 'DOUBLE') {
      amount = active.betAmount;
      if (!spend(io, table, p, amount)) return false;
      active.betAmount += amount; active.doubled = true;
    }
    active.cards.push(draw(table));
    active.stood = name === 'DOUBLE' || cards.evaluate(active.cards, active.splitHand).pointValue >= 21 || active.cards.length >= 5;
  }
  if (name === 'SPLIT') {
    amount = active.betAmount;
    if (!spend(io, table, p, amount)) return false;
    p.hands = active.cards.map((card, index) => ({ ...newHand([card, draw(table)], active.betAmount, true), handIndex: index }));
  }
  const a = actionRow(table, p, type, amount);
  p.actAt = now + robot.thinkTime();
  // Advance only after publishing the cards for the hand that just acted.
  h.deadline = now + h.rules.operateTime * 1000;
  broadcast(io, table, PUSH.ACTION, a);
  nextTurn(io, table, now);
  return true;
}
export function settle(io, table, now = Date.now()) {
  const h = table.hand;
  if (!h || h.settled || h.state !== STATE.DEALER) return false;
  h.settled = true; h.state = STATE.SETTLE; h.deadline = now + h.rules.settleTime; h.stateStart = now;
  const results = h.players.map(p => {
    for (const hand of p.hands) hand.score = cards.profit(hand, h.dealer);
    const gameScore = p.hands.reduce((n, h) => n + h.score, 0);
    const score = gameScore + p.insuranceProfit;
    p.member.point += totalBet(p) + p.insuranceAmount + score;
    p.member.state = 2;
    p.member.winStreak = score > 0 ? (p.member.winStreak || 0) + 1 : 0;
    table.houseNetScore = (table.houseNetScore || 0) - score;
    return { ...row(table, p), score, gameScore, xiaZhuData: totalBet(p) + p.insuranceAmount,
      handResults: handResults(p), cards: p.hands.flatMap(h => h.cards), ...cards.evaluate(p.hands[0].cards, p.hands[0].splitHand),
      winStreak: p.member.winStreak, publicDeckIndices: h.dealtIndices.slice() };
  });
  h.results = results; h.pot = results.reduce((n, r) => n + r.xiaZhuData, 0);
  for (const p of h.players) actionRow(table, p, ACTION.SETTLE);
  features.finishHandStats(table, results); fair.finishFairHand(table, results);
  history?.record(table, h, results);
  // State 8 starts the original chip-collection/award animation; keep it alive
  // through the configured interval before resetting any seat or card model.
  broadcast(io, table);
  emit(io, table, PUSH.SETTLE, { ...snapshot(table), actionList: h.actionList.filter(a => a.actionType === ACTION.SETTLE), settleList: results });
  features.pushRanking({ table, io });
  return true;
}
export function tick(io, table, now) {
  const h = table.hand;
  if (!h) return;
  if (h.settled) {
    if (now >= h.deadline) {
      h.state = STATE.END; broadcast(io, table);
      // The settlement interval already includes animation and the round gap.
      // Start on the next eligible tick after common admission/lifecycle checks.
      table.hand = null; table.phase = 'starting'; table.startAt = now;
    }
    return;
  }
  if (h.state === STATE.BET) {
    for (const p of h.players) if (!p.mainBet && (p.bot || p.member.pendingDeparture) && now >= p.actAt)
      act(io, table, p.uid, SEND.BET, { betAmount: robot.betAmount(p.member.point, h.rules.ante, h.rules.maxBet) }, now, true);
    if (now >= h.deadline) deal(io, table, now);
  } else if (h.state === STATE.DEAL && now >= h.deadline) {
    if (cards.cardValue(h.dealer[0]) === 1) {
      for (const p of h.players) p.actAt = now + robot.thinkTime();
      setPhase(io, table, STATE.INSURANCE, now, h.rules.insuranceTime * 1000);
    } else checkDealer(io, table, now);
  } else if (h.state === STATE.INSURANCE) {
    for (const p of h.players) if (!p.insuranceOperated && (now >= h.deadline || (p.bot || p.member.pendingDeparture) && now >= p.actAt))
      act(io, table, p.uid, SEND.INSURANCE, { buyInsurance: false }, now, true);
    if (h.players.every(p => p.insuranceOperated)) checkDealer(io, table, now);
  } else if (h.state === STATE.CHECK && now >= h.deadline) {
    if (cards.evaluate(h.dealer).handType === 5) {
      for (const p of h.players) for (const hand of p.hands) hand.stood = true;
    }
    nextTurn(io, table, now);
  } else if (h.state === STATE.PLAYER) {
    const p = current(table);
    if (now >= h.deadline || (p.bot || p.member.pendingDeparture) && now >= p.actAt) {
      const decision = now >= h.deadline || p.member.pendingDeparture ? 'STAND'
        : robot.choose(p.hands[p.currentHandIndex].cards, h.dealer[0], actions(table, p));
      act(io, table, p.uid, SEND[decision], {}, now, true);
    }
  } else if (h.state === STATE.DEALER && now >= h.deadline) {
    if (cards.evaluate(h.dealer).pointValue <= 16 && h.dealer.length < 5) {
      h.dealer.push(draw(table)); h.deadline = now + 1500;
      broadcast(io, table, PUSH.ACTION, actionRow(table, null, ACTION.HIT));
    } else settle(io, table, now);
  }
}
export function historyPayload(table, body, uid) {
  return history?.query(table, body, uid) || { currentInning: 0, total: 0, gameBackInfo: { gameRoomId: table.roomId,
    gameId: table.roomId, roomTypeName: 'bj21', ante: table.ante, playMode: table.playMode || 0, inningInfo: [[]] } };
}
