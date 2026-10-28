import { shuffle } from '../holdem/cards.js';
import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH: MSG } = await rel(import.meta.url, './messages.js', v);
const { evaluate, cardTypeInfo } = await rel(import.meta.url, './hand.js', v);
const { payouts } = await rel(import.meta.url, './scoring.js', v);
const robot = await rel(import.meta.url, './robot.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const fair = await rel(import.meta.url, '../../core/fair-code.js', v);
const { publicSeat, userInfoOf } = await rel(import.meta.url, '../../core/member.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/sgay-history.js', v) : null;
const rules = table => table.hand?.rules || table.roomRules;
const players = table => table.hand?.players || [];
const owner = (table, uid) => players(table).find(p => p.uid === Number(uid));
export const gameState = table => ({ deal: 'DEAL_PERFLOP', bet: 'XIAN_RAISE', show: 'FLOP' })[table.hand?.stage] || 'NONE';

export function visibleCards(table, p, uid) {
  if (p.shown) return p.hole.slice();
  if (p.uid !== Number(uid)) return [-1, -1, -1];
  return table.hand.stage === 'show' ? p.hole.slice() : [...p.hole.slice(0, 2), -1];
}
export const maxMultiple = (table, p) => Math.max(0, Math.min(10, Math.floor(p.member.point / rules(table).ante)));
function operation(table, uid, now = Date.now()) {
  const p = owner(table, uid), h = table.hand;
  if (!p || h.stage !== 'bet' || p.bet !== null || p.member.pendingDeparture) return [];
  return [{ operation: 1, data: { isEnable: true, ante: rules(table).ante, score: rules(table).ante,
    maxMultiple: maxMultiple(table, p), leftTime: Math.max(0, Math.ceil((h.deadline - now) / 1000)) } }];
}
function dealPayload(table, uid) {
  return players(table).map(p => {
    const cards = visibleCards(table, p, uid), visible = cards.every(c => c >= 0);
    return { uid: p.uid, pos: p.pos, cardList: cards,
      ...(visible ? { cardTypeInfo: cardTypeInfo(cards), cardTypeId: p.result.cardTypeId } : {}) };
  });
}
export function snapshot(table, session) {
  const h = table.hand;
  return { gameState: gameState(table), gameStateStartTime: h?.stageStartedAt || 0,
    currentInning: table.currentInning, uidList: players(table).map(p => p.uid),
    pot: h?.pot || 0, roundBetMap: Object.fromEntries(players(table).map(p => [p.uid, p.bet || 0])),
    currentOperatorId: 0, leftTime: h ? Math.max(0, Math.ceil((h.deadline - Date.now()) / 1000)) : 0,
    finalBetPlayerId: 0, finalBetPlayerPoint: 0, buyDelayCount: 0,
    memberDeskInfos: players(table).map(p => {
      const cards = visibleCards(table, p, session.userId), visible = cards.every(c => c >= 0);
      return { ...publicSeat(p.member), state: 3, xiaZhuData: p.bet || 0, banker: false,
        handPais: cards, showCards: p.shown ? p.hole.slice() : [-1, -1, -1],
        isLooked: p.uid === Number(session.userId), isShow: p.shown, lastOperation: p.bet === null ? 0 : 1,
        ...(visible ? { cardTypeId: p.result.cardTypeId, cardTypeInfo: cardTypeInfo(cards),
          tipsCardTypeInfo: { uid: p.uid, cardTypeInfo: cardTypeInfo(cards) } } : {}) };
    }) };
}
export function pushSnapshot(send, table, session) {
  const h = table.hand;
  if (!h) return;
  h.viewers.add(Number(session.userId));
  fair.watchFairHand(table, session.userId);
  send(3260, snapshot(table, session));
  send(MSG.OPERATION, operation(table, session.userId));
}
export function begin(io, table, now = Date.now(), deckOverride) {
  if (table.hand) return false;
  const members = table.members.filter(m => m.point >= table.ante && !m.carryDeadline && !m.pendingDeparture);
  if (members.length < 2) { table.phase = 'idle'; return false; }
  const deck = deckOverride || shuffle(Array.from({ length: 52 }, (_, i) => i));
  if (deck.length < members.length * 3 || new Set(deck).size !== deck.length
      || deck.some(c => !Number.isInteger(c) || c < 0 || c > 51)) throw new Error('Invalid Sgay deck');
  table.currentInning++; table.phase = 'playing';
  table.hand = { rules: structuredClone(table.roomRules), stage: 'deal', stageStartedAt: now, deck, pot: 0,
    deadline: now + table.roomRules.dealTimeMs, players: [], events: [],
    viewers: new Set([...(table.observers || []), ...members].map(m => Number(m.uid))) };
  table.hand.players = members.map((member, i) => {
    member.state = 3; member.totalBet = 0; member.lastOperation = 0;
    const hole = deck.slice(i * 3, i * 3 + 3);
    return { uid: member.uid, pos: member.pos, name: member.name, icon: member.icon, bot: member.bot, member,
      openingPoint: member.point, hole, result: evaluate(hole), bet: null, shown: false,
      actionAt: 0, showAt: 0 };
  });
  features.beginHandStats(table, table.hand.players);
  fair.beginFairHand(io, table, table.hand.players, 3);
  io.forEachPlayer?.(session => {
    if (session.sgayHydrateUntil > now) io.send(session.ws, 3260, snapshot(table, session));
    else io.send(session.ws, 3261, { currentInning: table.currentInning, uidList: members.map(p => p.uid),
      playMode: 0, roomStart: true, shuffleTime: 0, shuffleEndTime: 0, startTime: now });
  });
  io.broadcast(3263, 'DEAL_PERFLOP');
  io.forEachPlayer?.(session => io.send(session.ws, MSG.DEAL, dealPayload(table, session.userId)));
  return true;
}
function openBetting(io, table, now) {
  const h = table.hand; h.stage = 'bet'; h.stageStartedAt = now; h.deadline = now + rules(table).betTimeMs;
  for (const p of h.players) p.actionAt = now + robot.thinkTime('bet');
  io.broadcast(3263, 'XIAN_RAISE');
  io.forEachPlayer?.(session => io.send(session.ws, MSG.OPERATION, operation(table, session.userId, now)));
}
export function bet(io, table, uid, multiple, now = Date.now()) {
  const p = owner(table, uid), h = table.hand;
  if (!p || h.stage !== 'bet' || h.settled || p.bet !== null || now >= h.deadline
      || !Number.isInteger(multiple) || multiple < 1 || multiple > maxMultiple(table, p)) return false;
  const score = rules(table).ante * multiple;
  p.bet = score; p.member.point -= score; p.member.totalBet = score; p.member.lastOperation = 1; h.pot += score;
  h.events.push({ uid: p.uid, operationType: 1, operationData: multiple, bet: score, gameState: 4, time: now });
  io.broadcast(MSG.BET, { uid: p.uid, currentBetScore: score, totalBetScore: score,
    totalBetScoreMen: 0, totalBetScoreNotMen: 0, operation: 1, point: p.member.point, pot: h.pot });
  return true;
}
function reveal(io, table, now) {
  const h = table.hand; h.stage = 'show'; h.stageStartedAt = now; h.deadline = now + rules(table).revealTimeMs;
  h.earliest = now + 2500;
  for (const p of h.players) p.showAt = now + robot.thinkTime('show');
  io.broadcast(3263, 'FLOP');
  // Only the owner receives the third card for the original rubbing-card UI.
  // Everyone else continues to see masks until 4407 publishes the hand.
  io.forEachPlayer?.(session => io.send(session.ws, MSG.DEAL, dealPayload(table, session.userId)));
}
export function show(io, table, uid, body = {}, now = Date.now()) {
  const p = owner(table, uid), h = table.hand;
  if (!p || h.stage !== 'show' || p.shown || body.isShow === false
      || (body.card !== undefined && body.card !== p.hole[2])) return false;
  p.shown = true;
  h.events.push({ uid: p.uid, operationType: 5, gameState: 11, time: now });
  io.broadcast(MSG.SHOW, { uid: p.uid, pos: p.pos, isShow: true,
    cardTypeInfo: cardTypeInfo(p.hole), holeCardList: p.hole.slice() });
  return true;
}
export function settle(io, table, now = Date.now()) {
  const h = table.hand;
  if (!h || h.settled || h.stage !== 'show' || h.players.some(p => p.bet === null)) return false;
  for (const p of h.players) if (!p.shown) show(io, table, p.uid, {}, now);
  // Carry-in remains available during a hand. Preserve those real chips,
  // and exclude the deposit from winnings/tax instead of restoring an old stack.
  const r = rules(table), balances = h.players.map(p => ({ ...p, openingPoint: p.member.point + p.bet }));
  const paid = new Map(payouts(balances, r.ante, r.taxPercent, r.maxTax).map(p => [p.uid, p]));
  const results = h.players.map(p => {
    const payout = paid.get(p.uid), profile = userInfoOf(p.member);
    p.member.point = payout.point; p.member.state = 2; p.member.totalBet = 0;
    return { uid: p.uid, pos: p.pos, banker: false, name: profile.name, icon: profile.icon,
      xiaZhuData: p.bet, cardTypeId: p.result.cardTypeId, secondCardTypeId: 0,
      cardTypeInfo: cardTypeInfo(p.hole), showCards: p.hole.slice(), handPais: p.hole.slice(),
      playerStatus: 0, insuranceBet: 0, insuranceProfit: 0, winInsurance: 0,
      raiseMultiple: p.bet / r.ante, multipleAnte: p.bet, score: payout.score, point: payout.point,
      totalScore: payout.score, finallyScore: payout.score, isWin: payout.score > 0, take: 0,
      tax: payout.tax, bonus: payout.bonus };
  });
  h.settled = true;
  table.taxCollected = (table.taxCollected || 0) + results.reduce((n, p) => n + p.tax, 0);
  io.broadcast(3263, 'SETTLE');
  io.broadcast(MSG.SETTLE, results);
  features.finishHandStats(table, results);
  fair.finishFairHand(table, results);
  history?.record(table, h, results);
  table.hand = null; table.phase = 'starting'; table.startAt = now + r.settleTimeMs;
  features.pushRanking({ table, io });
  return true;
}
export function tick(io, table, now) {
  const h = table.hand; if (!h) return;
  if (h.stage === 'deal') { if (now >= h.deadline) openBetting(io, table, now); return; }
  if (h.stage === 'bet') {
    for (const p of h.players) {
      if (p.bet !== null) continue;
      if (now >= h.deadline) {
        // Expiry has a single default action through the same validated path.
        bet(io, table, p.uid, 1, h.deadline - 1);
      } else if ((p.bot || p.member.pendingDeparture || p.member.tuoGuanState) && now >= p.actionAt) {
        bet(io, table, p.uid, robot.chooseMultiple({ cards: p.hole.slice(0, 2),
          maxMultiple: maxMultiple(table, p), point: p.member.point, ante: rules(table).ante }), now);
      }
    }
    if (h.players.every(p => p.bet !== null)) reveal(io, table, now);
  } else if (h.stage === 'show') {
    for (const p of h.players) if (!p.shown && (now >= h.deadline
      || ((p.bot || p.member.pendingDeparture || p.member.tuoGuanState) && now >= p.showAt))) show(io, table, p.uid, {}, now);
    if (now >= h.earliest && h.players.every(p => p.shown)) settle(io, table, now);
  }
}
export function historyPayload(table, body, uid) {
  return history?.query(table, body, uid) || { gameRoomId: table.roomId, roomTypeName: 'sgya',
    blind: JSON.stringify({ ante: table.ante }), totalNum: 0, playBackList: [], isOfflineData: false };
}
export const historyDetail = (...args) => history?.historyDetail(...args) || null;
