import { shuffle } from '../holdem/cards.js';
import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH: MSG } = await rel(import.meta.url, './messages.js', v);
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { evaluate, compareHands } = await rel(import.meta.url, './hand.js', v);
const robot = await rel(import.meta.url, './robot.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const fair = await rel(import.meta.url, '../../core/fair-code.js', v);
const { userInfoOf, publicSeat } = await rel(import.meta.url, '../../core/member.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/niuniu-history.js', v) : null;

const rules = table => table.hand?.rules || table.roomRules;

export function timeConfig(table) {
  const r = rules(table);
  return { grabBankerTime: r.grabBankerTime, raiseTime: r.raiseTime, fastTime: r.fastTime,
    preFlopCardShowTime: 1000, bankerShowTime: 3000, settleTime: r.settleTime,
    fastMode: r.fastLook, settleAndMoveTime: 4000 };
}
const players = table => table.hand?.players || [];
const owner = (table, uid) => players(table).find(p => p.uid === Number(uid));
const sendUser = (io, uid, id, data) => io.sendUser?.(uid, id, data);
const state = table => ({ grab: 'DEAL_PERFLOP', banker: 'CONFIRM_BANKER', bet: 'XIAN_RAISE',
  show: 'RUBBING_CARDS' })[table.hand?.stage] || 'NONE';
function visibleCards(table, p, uid) {
  if (p.shown) return p.hole.slice();
  if (p.uid !== Number(uid)) return [];
  return p.hole.slice(0, table.hand.stage === 'show' ? 5 : rules(table).seeCardNo);
}
function niuInfo(table, p, uid) {
  const cards = visibleCards(table, p, uid);
  const shown = cards.length === 5;
  return { playerId: p.uid, cardList: cards, niuJi: shown ? p.result.niuJi : 0,
    niuType: shown ? p.result.niuType : 0, belv: shown ? p.result.belv : 0,
    cardType: shown ? p.result.cardType : 'NONE', qilaiCardType: shown ? p.result.qilaiCardType : 'NONE',
    combinationsCard: shown ? p.result.combinationsCard.slice() : [],
    handCardListWithLaiZi: shown ? p.result.handCardListWithLaiZi.slice() : cards.slice() };
}

export function grabMax(table, p) {
  if (p.openingPoint < rules(table).grabBankerPoint) return 0;
  const max = Math.floor(p.openingPoint / Math.max(1, table.ante * rules(table).bettingMultiples[0]));
  return Math.min(max, rules(table).grabBankerMax);
}
export function betOptions(table, p) {
  const hand = table.hand;
  const factor = table.ante * hand.bankerMultiple;
  const allowed = rules(table).bettingMultiples.filter(n => factor * n <= p.openingPoint);
  // The original UI has a group for each supported number of buttons. A
  // short-stacked player still has the minimum bet, with loss capped at chips.
  return allowed.length ? allowed : [rules(table).bettingMultiples[0]];
}

export function snapshot(table, session) {
  const uid = session.userId, hand = table.hand;
  const me = owner(table, uid);
  return { gameState: state(table), currentInning: table.currentInning,
    gameStart: Boolean(hand), roomStart: true, timeConfig: timeConfig(table),
    leftTime: hand ? Math.max(0, hand.deadline - Date.now()) : 0,
    uidList: players(table).map(p => p.uid),
    grabBanker: me ? me.grab !== null : false, raisePoint: me ? me.bet !== null : false,
    memberDeskInfos: table.members.map(member => {
      const p = owner(table, member.uid), info = userInfoOf(member);
      const cards = p ? visibleCards(table, p, uid) : [];
      return { ...publicSeat(member), name: info.name, icon: info.icon,
        remarkName: info.remarkName, sex: info.sex, regionCode: info.regionCode,
        isOnLine: !member.pendingDeparture,
        banker: p?.uid === hand?.bankerUid, cardIndex: -1, grabBankerMax: p ? grabMax(table, p) : 0,
        grabBankerPoint: p?.grab ?? -1, raiseMultiples: p?.bet ?? -1,
        bettingMultiples: p && hand.stage === 'bet' && p.uid !== hand.bankerUid ? betOptions(table, p) : [],
        autoStrategyState: Boolean(member.niuniuAuto?.status),
        qznnShowCard: p?.shown || false, pingPaiDone: p?.combined || false,
        niuInfo: p ? niuInfo(table, p, uid) : { playerId: member.uid, cardList: [], combinationsCard: [], handCardListWithLaiZi: [], niuJi: 0, niuType: 0 },
        handPais: cards, formingCard: { cards, handCardListWithLaiZi: cards } };
    }) };
}
export function pushSnapshot(send, table, session) {
  send(MSG.CONFIG, timeConfig(table));
  send(2225, Boolean(table.members.find(m => m.uid === session.userId)?.standAfterRound));
  if (table.hand) {
    table.hand.viewers.add(Number(session.userId));
    send(PUSH.NIUNIU_INNING_BEGIN_INFO, snapshot(table, session));
    if (table.playMode === 7) send(MSG.LAIZI, table.hand.laiZi);
  }
}

export function begin(io, table, now = Date.now(), deckOverride) {
  const members = table.members.filter(p => p.point > 0 && !p.carryDeadline && !p.pendingDeparture);
  if (members.length < 2) { table.phase = 'idle'; return; }
  const deck = deckOverride || shuffle(Array.from({ length: table.playMode === 7 ? 55 : 52 }, (_, i) => i));
  const laiZi = table.playMode === 7 ? Math.floor(Math.random() * 13) : -1;
  table.currentInning++;
  table.phase = 'playing';
  const handRules = structuredClone(rules(table));
  table.hand = { rules: handRules, stage: 'grab', deck, laiZi, players: [], bankerUid: 0, bankerMultiple: 1, pot: 0,
    viewers: new Set([...(table.observers || []), ...members].map(p => Number(p.uid))),
    deadline: now + 1000 + rules(table).grabBankerTime + 500,
    earliest: now + 1000, botActAt: now + 1500 };
  table.hand.players = members.map((member, i) => {
    const hole = deck.slice(i * 5, i * 5 + 5);
    member.state = 4; member.totalBet = 0;
    return { uid: member.uid, pos: member.pos, name: member.name, icon: member.icon, bot: member.bot,
      member, hole, openingPoint: member.point, grab: null, bet: null, shown: false, combined: false,
      result: evaluate(hole, rules(table), laiZi) };
  });
  features.beginHandStats(table, table.hand.players);
  fair.beginFairHand(io, table, table.hand.players, 5);
  io.forEachPlayer?.(session => {
    if (session.niuniuHydrateUntil > now) {
      io.send(session.ws, PUSH.NIUNIU_INNING_BEGIN_INFO, snapshot(table, session));
    } else {
      io.send(session.ws, PUSH.NIUNIU_CURRENT_INNING_BEGIN_INFO, { currentInning: table.currentInning,
        uidList: members.map(p => p.uid), roomStart: true });
    }
  });
  io.broadcast(MSG.CONFIG, timeConfig(table));
  if (table.playMode === 7) io.broadcast(MSG.LAIZI, laiZi);
  io.forEachPlayer?.(session => io.send(session.ws, MSG.DEAL, players(table).map(p => {
    const cards = visibleCards(table, p, session.userId);
    return { uid: p.uid, pos: p.pos, grabBankerMax: grabMax(table, p), cardList: cards,
      formingCard: { cards, handCardListWithLaiZi: cards }, grabBankerPoint: -1 };
  })));
}

export function grab(io, table, uid, count) {
  const p = owner(table, uid), hand = table.hand;
  if (!p || hand.stage !== 'grab' || p.grab !== null || !Number.isSafeInteger(count) || count < 0 || count > grabMax(table, p)) return false;
  p.grab = count;
  io.broadcast(MSG.GRAB, [{ playerId: p.uid, count }]);
  return true;
}
function selectBanker(io, table, now) {
  const hand = table.hand;
  const top = Math.max(...hand.players.map(p => p.grab || 0));
  const candidates = hand.players.filter(p => (p.grab || 0) === top);
  const banker = candidates[Math.floor(Math.random() * candidates.length)];
  hand.bankerUid = banker.uid; hand.bankerMultiple = Math.max(1, banker.grab || 0);
  hand.stage = 'banker'; hand.deadline = now + 3500;
  io.broadcast(MSG.BANKER, hand.players.map(p => ({ playerId: p.uid, banker: p === banker,
    cardIndex: -1, point: p.member.point })));
}
function openBetting(io, table, now) {
  const hand = table.hand;
  hand.stage = 'bet'; hand.deadline = now + rules(table).raiseTime + 500;
  hand.earliest = now + 700; hand.botActAt = now + 900;
  io.forEachPlayer?.(session => {
    const p = owner(table, session.userId);
    io.send(session.ws, MSG.RAISE, { bankerId: hand.bankerUid, bettingType: 2,
      bettingMultiples: p && p.uid !== hand.bankerUid ? betOptions(table, p) : [],
      doublePoint: rules(table).doublePoint, gameStatus: 'XIAN_RAISE' });
  });
  // 3608 updates multipliers only. The unmodified client opens its betting
  // controls on the separate 3263 phase event.
  io.broadcast(PUSH.BRNN_GAME_STATE_PUSH, 'XIAN_RAISE');
}
export function bet(io, table, uid, multiple) {
  const p = owner(table, uid), hand = table.hand;
  if (!p || hand.stage !== 'bet' || p.uid === hand.bankerUid || p.bet !== null || !betOptions(table, p).includes(multiple)) return false;
  p.bet = multiple;
  io.broadcast(MSG.BET, [{ playerId: p.uid, multiple, multipleAnte: table.ante * multiple,
    point: p.member.point }]);
  return true;
}
function reveal(io, table, now) {
  const hand = table.hand;
  hand.stage = 'show'; hand.deadline = now + rules(table).fastTime + 1000;
  hand.earliest = now + 2000; hand.botActAt = now + 1600;
  io.forEachPlayer?.(session => {
    const p = owner(table, session.userId);
    io.send(session.ws, MSG.REVEAL, { niuInfo: p ? niuInfo(table, p, p.uid) : {},
      leftTime: rules(table).fastTime });
  });
}
export function show(io, table, uid) {
  const p = owner(table, uid);
  if (!p || table.hand.stage !== 'show' || p.shown) return false;
  p.shown = true;
  io.broadcast(MSG.SHOW, { uid: p.uid, niuInfo: niuInfo(table, p, p.uid) });
  return true;
}
export function combine(io, table, uid) {
  const p = owner(table, uid);
  if (!p || table.hand.stage !== 'show' || p.combined) return false;
  p.combined = true;
  io.broadcast(MSG.COMBINE, { uid: p.uid, pingPaiDone: true });
  return true;
}

// Pure settlement: all liabilities are bounded by opening chips, winner gains
// by their own opening chips; banker pays stronger winning hands first.
export function payouts(table) {
  const hand = table.hand, banker = owner(table, hand.bankerUid);
  const scores = new Map(hand.players.map(p => [p.uid, 0]));
  let bank = banker.openingPoint;
  const winners = [];
  for (const p of hand.players) {
    if (p === banker) continue;
    const won = compareHands(p.result, banker.result) > 0;
    const factor = table.ante * hand.bankerMultiple * p.bet;
    const amount = Math.min(p.openingPoint, Math.floor(factor * (won ? p.result.belv : banker.result.belv)));
    if (won) winners.push({ p, amount });
    else { scores.set(p.uid, -amount); bank += amount; }
  }
  winners.sort((a,b) => compareHands(b.p.result,a.p.result) || a.p.pos - b.p.pos);
  for (const { p, amount } of winners) {
    const win = Math.min(amount, bank);
    scores.set(p.uid, win); bank -= win;
  }
  scores.set(banker.uid, bank - banker.openingPoint);
  // The banker's own net win is also capped by its opening bankroll. Return
  // the excess to losing players, proportionally with deterministic odd chips.
  const excess = Math.max(0, scores.get(banker.uid) - banker.openingPoint);
  if (excess > 0) {
    const losers = hand.players.filter(p => scores.get(p.uid) < 0);
    const loss = losers.reduce((sum,p) => sum - scores.get(p.uid), 0);
    let left = excess;
    losers.forEach((p,i) => {
      const refund = i === losers.length - 1 ? left
        : Number(BigInt(excess) * BigInt(-scores.get(p.uid)) / BigInt(loss));
      scores.set(p.uid, scores.get(p.uid) + refund); left -= refund;
    });
    scores.set(banker.uid, banker.openingPoint);
  }
  return scores;
}
export function settle(io, table, now = Date.now()) {
  const hand = table.hand;
  if (!hand || hand.settled) return;
  const scores = payouts(table);
  const results = hand.players.map(p => {
    const score = scores.get(p.uid);
    p.member.point += score; p.member.state = 2;
    return { ...niuInfo(table, { ...p, shown: true }, p.uid), uid: p.uid, pos: p.pos,
      handPais: p.hole.slice(), showCards: p.hole.slice(), banker: p.uid === hand.bankerUid,
      grabBankerPoint: p.grab || 0, raiseMultiple: p.bet || 0,
      multipleAnte: table.ante * (p.bet || 0), xiaZhuData: Math.abs(score),
      insurance: 0, score, point: p.member.point };
  });
  hand.settled = true;
  hand.pot = results.reduce((sum, p) => sum + Math.max(0, p.score), 0);
  io.broadcast(MSG.SETTLE, results);
  features.finishHandStats(table, results);
  fair.finishFairHand(table, results);
  history?.record(table, hand, results);
  for (const p of hand.players) {
    const auto = p.member.niuniuAuto;
    if (!auto?.status) continue;
    const profit = p.member.point - auto.startPoint;
    if ((auto.stopWinAmt > 0 && profit >= auto.stopWinAmt * 100)
        || (auto.stopLoseAmt > 0 && profit <= -auto.stopLoseAmt * 100)) {
      auto.status = 0; p.member.standAfterRound = true;
      io.broadcast(MSG.AUTO_STATUS, { uid: p.uid, status: 0 });
    }
  }
  table.hand = null;
  table.phase = 'starting'; table.startAt = now + rules(table).settleTime;
  features.pushRanking({ table, io });
}

export function tick(io, table, now) {
  const hand = table.hand;
  if (!hand) return;
  if (now >= hand.botActAt) {
    for (const p of hand.players) {
      const auto = p.member.niuniuAuto;
      if (!p.bot && !p.member.pendingDeparture && !auto?.status) continue;
      const visible = visibleCards(table, p, p.uid);
      // Only the initial known cards determine the configured auto strategy.
      const initial = p.hole.slice(0, rules(table).seeCardNo);
      const special = initial.length >= 3 && initial.every(c => c >= 52 || c % 13 >= 9);
      const policy = auto?.status ? { grab: special ? auto.specialGrabBank : auto.tenGrabBank,
        multiple: special ? auto.specialMultiple : auto.tenMultiple } : null;
      if (hand.stage === 'grab' && p.grab === null) grab(io, table, p.uid,
        robot.choose({ cards: visible, grabMax: grabMax(table, p), phase: 'grab', auto: policy }));
      if (hand.stage === 'bet' && p.bet === null && p.uid !== hand.bankerUid) bet(io, table, p.uid,
        robot.choose({ cards: visible, multiples: betOptions(table, p), phase: 'bet', auto: policy }));
      if (hand.stage === 'show') show(io, table, p.uid);
    }
    hand.botActAt = now + 700;
  }
  const expired = now >= hand.deadline;
  if (hand.stage === 'grab') {
    if (expired) for (const p of hand.players) if (p.grab === null) grab(io, table, p.uid, 0);
    if (now >= hand.earliest && hand.players.every(p => p.grab !== null)) selectBanker(io, table, now);
  } else if (hand.stage === 'banker' && expired) openBetting(io, table, now);
  else if (hand.stage === 'bet') {
    if (expired) for (const p of hand.players) if (p.uid !== hand.bankerUid && p.bet === null) bet(io, table, p.uid, betOptions(table,p)[0]);
    if (now >= hand.earliest && hand.players.every(p => p.uid === hand.bankerUid || p.bet !== null)) reveal(io, table, now);
  } else if (hand.stage === 'show') {
    if (expired) for (const p of hand.players) show(io, table, p.uid);
    if (now >= hand.earliest && hand.players.every(p => p.shown)) settle(io, table, now);
  }
}

export function historyPayload(table, body, uid) {
  return history?.query(table, body, uid) || { gameRoomId: table.roomId, roomTypeName: 'qznn', ante: table.ante,
    blind: JSON.stringify({ ante: table.ante }), totalNum: 0,
    dataInfo: { currentInningNum: Number(body.inningNum) || 0, firstGameList: [] } };
}
