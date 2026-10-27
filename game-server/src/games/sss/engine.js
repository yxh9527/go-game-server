import { rel } from '../../rel.js';
import { shuffle } from '../holdem/cards.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, './messages.js', v);
const handLogic = await rel(import.meta.url, './hand.js', v);
const robot = await rel(import.meta.url, './robot.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const fair = await rel(import.meta.url, '../../core/fair-code.js', v);
const { publicSeat } = await rel(import.meta.url, '../../core/member.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/sss-history.js', v) : null;
const rules = table => table.hand?.rules || table.roomRules;
const owner = (table, uid) => table.hand?.players.find(p => p.uid === Number(uid));
export const gameState = table => table.hand ? table.hand.settled ? 'COMPARE_HANDS' : 'ARRANGE_HANDS' : 'NONE';

function dealRow(table, p, uid, now = Date.now()) {
  const own = p.uid === Number(uid), arranged = Boolean(p.result);
  const visible = own || table.hand.settled;
  const natural = own && !arranged && p.options[0]?.specialType ? p.options[0] : null;
  // The original panel auto-acknowledges special hands when frontType is
  // absent, and its special deal animation reads these three arrays directly.
  const options = natural ? [{ front: natural.front, middle: natural.middle,
    back: natural.back, specialType: natural.specialType }] : p.options;
  return { uid: p.uid, pos: p.pos, tuoguanStatus: false, hasArranged: arranged,
    arrangedLastTime: arranged ? 0 : Math.max(0, (p.deadline ?? table.hand.deadline) - now), arrangedCount: p.extensionsLeft || 0,
    cardList: own ? p.hole.slice() : null, handPais: own ? p.hole.slice() : null,
    arrangementOptions: own && !arranged ? options : null,
    frontCards: visible && arranged ? p.front : natural?.front || [], middleCards: visible && arranged ? p.middle : natural?.middle || [],
    backCards: visible && arranged ? p.back : natural?.back || [],
    horseCardPosition: arranged ? p.result.horseCardPosition : 0,
    horseCardPositionIndex: arranged ? p.result.horseCardPositionIndex : -1,
    ...(visible && arranged ? { evalResult: p.result } : {}) };
}
export function snapshot(table, session) {
  const hand = table.hand;
  return { gameState: gameState(table), currentInning: table.currentInning,
    gameStart: Boolean(hand), roomStart: true, uidList: hand?.players.map(p => p.uid) || [],
    leftTime: hand ? Math.max(0, hand.deadline - Date.now()) : 0,
    memberDeskInfos: table.members.map(m => {
      const p = owner(table, m.uid);
      return { ...publicSeat(m), ...(p ? dealRow(table, p, session.userId) : { handPais: null,
        hasArranged: true, arrangementOptions: null, frontCards: [], middleCards: [], backCards: [] }) };
    }), ...(hand?.settled ? { compareResult: hand.comparison } : {}) };
}
export function pushSnapshot(send, table, session) {
  if (table.hand) {
    table.hand.viewers.add(Number(session.userId));
    send(PUSH.SNAPSHOT, snapshot(table, session));
  }
  send(PUSH.STATE, gameState(table));
}
export function begin(io, table, now = Date.now(), deckOverride) {
  const members = table.members.filter(p => p.point > 0 && !p.carryDeadline && !p.pendingDeparture);
  if (members.length < 2) { table.phase = 'idle'; return; }
  const deck = deckOverride || shuffle(handLogic.deckFor(table.playMode));
  table.currentInning++; table.phase = 'playing';
  table.hand = { rules: structuredClone(table.roomRules), deck, players: [], settled: false,
    deadline: now + rules(table).arrangeTime * 1000 + 4500, earliest: now + 6500,
    viewers: new Set([...(table.observers || []), ...members].map(p => Number(p.uid))) };
  table.hand.players = members.map((member, index) => {
    const hole = deck.slice(index * 13, index * 13 + 13);
    member.state = 4; member.totalBet = 0;
    return { uid: member.uid, pos: member.pos, name: member.name, icon: member.icon, member, bot: member.bot, hole,
      openingPoint: member.point, options: handLogic.arrange(hole), result: null,
      deadline: table.hand.deadline, extensionsLeft: rules(table).arrangeExtendCount,
      actAt: now + robot.thinkTime() };
  });
  features.beginHandStats(table, table.hand.players);
  fair.beginFairHand(io, table, table.hand.players, 13);
  io.broadcast(PUSH.BEGIN, { currentInning: table.currentInning, roomStart: true, uidList: members.map(p => p.uid) });
  io.broadcast(PUSH.STATE, 'DEAL_PERFLOP');
  io.forEachPlayer?.(s => io.send(s.ws, PUSH.DEAL, table.hand.players.map(p => dealRow(table, p, s.userId, now))));
  io.broadcast(PUSH.STATE, 'ARRANGE_HANDS');
}
export function arrange(io, table, uid, body) {
  const p = owner(table, uid), hand = table.hand;
  if (!p || hand.settled || p.result || !handLogic.validArrangement(p.hole, body.front, body.middle, body.back)) return false;
  p.front = body.front.slice(); p.middle = body.middle.slice(); p.back = body.back.slice();
  p.result = handLogic.evaluate(p.front, p.middle, p.back);
  // A legal thirteen-card multiset may be a foul. The rules score a foul as
  // a loss; accepting it does not substitute or silently reorder user cards.
  io.broadcast(PUSH.ARRANGE, { uid: p.uid, roomId: table.roomId, hasArranged: true,
    arrangedLastTime: 0, arrangedCount: 0, horseCardPosition: p.result.horseCardPosition,
    horseCardPositionIndex: p.result.horseCardPositionIndex });
  return true;
}
export function addTime(io, table, uid, now = Date.now()) {
  const p = owner(table, uid), hand = table.hand;
  if (!p || hand.settled || p.result || now >= (p.deadline ?? hand.deadline) || !(p.extensionsLeft > 0)) return false;
  p.extensionsLeft--;
  p.deadline += rules(table).arrangeExtendSeconds * 1000;
  hand.deadline = Math.max(hand.deadline, p.deadline);
  io.broadcast(PUSH.TIME, { uid: p.uid, arrangedLastTime: p.deadline - now, arrangedCount: p.extensionsLeft });
  return true;
}
function pair(a, b) {
  const ar = a.result, br = b.result;
  const water = [0, 0, 0];
  let specialWater = 0;
  const horse = ar.hasHorseCard || br.hasHorseCard;
  if (ar.isWater || br.isWater) {
    if (ar.isWater !== br.isWater) {
      const winner = ar.isWater ? br : ar, sign = ar.isWater ? -1 : 1;
      if (winner.hasSpecialType) specialWater = sign * winner.specialType.water;
      else ['frontHand', 'middleHand', 'backHand'].forEach((k, i) => water[i] = sign * winner[k].water);
    }
  } else if (ar.hasSpecialType || br.hasSpecialType) {
    const x = ar.specialType, y = br.specialType;
    const cmp = x && y ? Math.sign(x.strength - y.strength) : x ? 1 : -1;
    specialWater = cmp * (cmp > 0 ? x.water : cmp < 0 ? y.water : 0);
  } else {
    ['frontHand', 'middleHand', 'backHand'].forEach((k, i) => {
      const cmp = handLogic.compareKey(ar[k].key, br[k].key);
      water[i] = cmp > 0 ? ar[k].water : cmp < 0 ? -br[k].water : 0;
    });
  }
  // Ties count towards a scoop, but at least one pile must actually win.
  const oneScoop = !specialWater && !ar.isWater && !br.isWater && !ar.hasSpecialType && !br.hasSpecialType
    && water.every(n => n >= 0) && water.some(n => n > 0);
  const twoScoop = !specialWater && !ar.isWater && !br.isWater && !ar.hasSpecialType && !br.hasSpecialType
    && water.every(n => n <= 0) && water.some(n => n < 0);
  return { a, b, water, specialWater, horse, oneScoop, twoScoop };
}
export function comparison(table) {
  const players = table.hand.players, pairs = [];
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) pairs.push(pair(players[i], players[j]));
  const homeRunPlayerIds = players.length >= 3 ? players.filter(p => pairs.filter(x => x.a === p || x.b === p)
    .every(x => x.a === p ? x.oneScoop : x.twoScoop)).map(p => p.uid) : [];
  const compareResults = {}, playerResults = {}, playerStatsMap = {}, scoreMap = {}, totalWaterMap = {};
  for (const p of players) {
    compareResults[p.uid] = {}; playerResults[p.uid] = structuredClone(p.result);
    playerStatsMap[p.uid] = { frontTotalWater: 0, middleTotalWater: 0, backTotalWater: 0,
      totalWater: 0, score: 0, hasHomeRun: homeRunPlayerIds.includes(p.uid) };
  }
  for (const x of pairs) {
    const gun = x.oneScoop || x.twoScoop;
    const home = x.oneScoop ? homeRunPlayerIds.includes(x.a.uid) : x.twoScoop && homeRunPlayerIds.includes(x.b.uid);
    const multiple = (x.horse ? 2 : 1) * (home ? 4 : gun ? 2 : 1);
    x.totalWater = (x.water.reduce((s, n) => s + n, 0) + x.specialWater) * multiple;
    x.amount = Math.min(Math.abs(x.totalWater * table.ante), x.a.openingPoint, x.b.openingPoint);
    x.debtor = x.totalWater >= 0 ? x.b : x.a;
  }
  // Allocate each debtor's opening bankroll across pair liabilities, so
  // simultaneous losses cannot spend more than the funded seat owns.
  for (const p of players) {
    const debts = pairs.filter(x => x.debtor === p && x.amount > 0);
    const total = debts.reduce((s, x) => s + x.amount, 0);
    if (total <= p.openingPoint) continue;
    let left = p.openingPoint;
    debts.forEach((x, i) => {
      x.amount = i === debts.length - 1 ? left
        : Number(BigInt(x.amount) * BigInt(p.openingPoint) / BigInt(total));
      left -= x.amount;
    });
  }
  const scoopRelations = [], specialResults = [];
  for (const x of pairs) {
    const score = Math.sign(x.totalWater) * x.amount;
    const make = sign => ({ player1Score: score * sign, player2Score: -score * sign,
      frontWin: x.water[0] * sign > 0, middleWin: x.water[1] * sign > 0, backWin: x.water[2] * sign > 0,
      frontWater: x.water[0] * sign, middleWater: x.water[1] * sign, backWater: x.water[2] * sign,
      specialWater: x.specialWater * sign, totalWater: x.totalWater * sign,
      hasHorseCard: x.horse, player1Scoop: sign > 0 ? x.oneScoop : x.twoScoop,
      player2Scoop: sign > 0 ? x.twoScoop : x.oneScoop,
      isScoop: sign > 0 ? x.oneScoop : x.twoScoop, isScooped: sign > 0 ? x.twoScoop : x.oneScoop });
    compareResults[x.a.uid][x.b.uid] = make(1); compareResults[x.b.uid][x.a.uid] = make(-1);
    for (const [p, sign] of [[x.a, 1], [x.b, -1]]) {
      const stats = playerStatsMap[p.uid];
      ['front', 'middle', 'back'].forEach((k, i) => stats[k + 'TotalWater'] += x.water[i] * sign);
      stats.totalWater += x.totalWater * sign; stats.score += score * sign;
    }
    if (x.oneScoop || x.twoScoop) scoopRelations.push([x.oneScoop ? x.a.uid : x.b.uid,
      x.oneScoop ? x.b.uid : x.a.uid, 0, 0]);
  }
  for (const p of players) {
    scoreMap[p.uid] = playerStatsMap[p.uid].score; totalWaterMap[p.uid] = playerStatsMap[p.uid].totalWater;
    playerResults[p.uid].totalWater = totalWaterMap[p.uid];
    if (p.result.hasSpecialType) specialResults.push({ playerId: p.uid, specialScore: { ...scoreMap } });
  }
  for (const row of specialResults) row.specialScore = { ...scoreMap };
  for (const row of scoopRelations) { row[2] = scoreMap[row[0]]; row[3] = scoreMap[row[1]]; }
  return { compareResults, playerResults, playerStatsMap, totalWaterMap, scoreMap,
    scoopRelations, homeRunPlayerIds, specialResults };
}
export function settle(io, table, now = Date.now()) {
  const hand = table.hand;
  if (!hand || hand.settled || hand.players.some(p => !p.result)) return false;
  const result = comparison(table);
  const specialPlayers = hand.players.filter(p => p.result.hasSpecialType).length;
  const animationTime = 4500 + (hand.players.length - specialPlayers) * 3000
    + specialPlayers * 1000 + result.scoopRelations.length * 2000;
  hand.settled = true; hand.comparison = result;
  hand.deadline = now + Math.max(rules(table).settleTime, animationTime);
  const results = hand.players.map(p => {
    const score = result.scoreMap[p.uid]; p.member.point += score; p.member.state = 2;
    return { uid: p.uid, pos: p.pos, point: p.member.point, score, xiaZhuData: Math.abs(score),
      handPais: p.hole.slice(), showCards: p.hole.slice(), frontCards: p.front, middleCards: p.middle,
      backCards: p.back, evalResult: result.playerResults[p.uid], totalWater: result.totalWaterMap[p.uid] };
  });
  hand.results = results;
  hand.pot = results.reduce((sum, p) => sum + Math.max(0, p.score), 0);
  features.finishHandStats(table, results); fair.finishFairHand(table, results);
  history?.record(table, hand, results);
  io.broadcast(PUSH.STATE, 'COMPARE_HANDS');
  io.broadcast(PUSH.SETTLE, results);
  io.broadcast(PUSH.COMPARE, { roomId: table.roomId, currentInning: table.currentInning, compareResult: result });
  features.pushRanking({ table, io });
  return true;
}
export function tick(io, table, now) {
  const hand = table.hand;
  if (!hand) return;
  if (hand.settled) {
    if (now >= hand.deadline) {
      io.broadcast(PUSH.STATE, 'INNER_END'); table.hand = null; table.phase = 'starting'; table.startAt = now + 3000;
    }
    return;
  }
  for (const p of hand.players) if (!p.result && (now >= (p.deadline ?? hand.deadline)
    || ((p.bot || p.member.pendingDeparture) && now >= p.actAt))) {
    const option = robot.choose(p.options);
    if (option) arrange(io, table, p.uid, option);
  }
  if (now >= hand.earliest && hand.players.every(p => p.result)) settle(io, table, now);
}
export function historyPayload(table, body, uid) {
  return history?.query(table, body, uid) || { gameRoomId: table.roomId, roomTypeName: 'sss', ante: table.ante,
    blind: JSON.stringify({ ante: table.ante }), totalNum: 0, dataInfo: null };
}
