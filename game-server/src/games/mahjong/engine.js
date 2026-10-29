import { randomInt } from 'node:crypto';
import { rel } from '../../rel.js';
import { env } from '../../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const tiles = await rel(import.meta.url, './tiles.js', v);
const { evaluate, smallHu } = await rel(import.meta.url, './hand.js', v);
const { OP, PROTOCOL } = await rel(import.meta.url, './messages.js', v);
const { transfer } = await rel(import.meta.url, './scoring.js', v);
const robot = await rel(import.meta.url, './robot.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
const fair = await rel(import.meta.url, '../../core/fair-code.js', v);
const history = env.isDev ? await rel(import.meta.url, '../../../../cache/game-server/mahjong-history.js', v) : null;
const rule = table => table.hand?.rules || table.roomRules;
const proto = table => PROTOCOL[rule(table).family];
const player = (table, uid) => table.hand?.players.find(p => p.uid === Number(uid));
const left = h => (h.tailIndex ?? h.deck.length) - h.index;
function takeWall(h, tail = false) {
  if (!left(h)) return null;
  h.tailIndex ??= h.deck.length;
  const index = tail ? --h.tailIndex : h.index++;
  return { card: h.deck[index], index };
}
const each = (io, fn) => io.forEachPlayer?.(session => fn(session.userId, (id, data) => io.send(session.ws, id, data)));
const privateSend = (io, uid, id, data) => each(io, (viewer, send) => { if (Number(viewer) === Number(uid)) send(id, data); });
const next = (h, p) => h.players[(h.players.indexOf(p) + 1) % h.players.length];
const isAuto = p => p.bot || p.member.pendingDeparture || p.member.tuoGuanState;
const sort = p => {
  const paired = p.handCards.map((card, i) => ({ card, index: p.indices[i] })).sort((a, b) => a.card - b.card);
  p.handCards = paired.map(t => t.card); p.indices = paired.map(t => t.index);
};
function remove(p, cards) {
  if (!tiles.contains(p.handCards, cards)) throw new Error('Missing Mahjong tile');
  return cards.map(c => { const i = p.handCards.indexOf(c); p.handCards.splice(i, 1); return p.indices.splice(i, 1)[0]; });
}
function add(h, p) {
  const tile = takeWall(h); if (!tile) return null;
  const { index, card } = tile;
  if (h.rules.family === 'jsmj' && card === 30) {
    p.flowers++; h.publicIndices.add(index);
    transfer(h.players.filter(other => other !== p).map(from => ({ from, to: p, amount: h.rules.diFen })), 1, '补花');
    return { card, index, flower: true };
  }
  p.handCards.push(card); p.indices.push(index); return { card, index, flower: false };
}
function context(table, p, extra = {}) {
  const h = table.hand;
  return { selfDraw: true, queType: p.queType, ting: p.ting, heavenTing: p.heavenTing, flowers: p.flowers,
    addFanCard: h.addFanCard, roots: p.roots, redKongs: p.redKongs,
    afterKong: p.afterKong, lastCard: left(h) === 0,
    heaven: h.discardCount === 0 && p.pos === h.bankerPos,
    earth: p.pos !== h.bankerPos && p.drawCount === 1 && p.discardCount === 0, ...extra };
}
export function waits(table, p, cards = p.handCards) {
  const r = rule(table), available = tiles.counts(tiles.deckFor(r)), own = tiles.counts(cards.concat(p.groupCards.flatMap(g => g.cards)));
  // Only this hand and public information contribute to remaining counts.
  const publicCounts = tiles.counts((table.hand.revealedWinTiles || []).concat(table.hand.players.flatMap(other => other.playCards.concat(other === p ? [] : other.groupCards.flatMap(g => g.type === OP.AN_GANG ? [] : g.cards)))));
  const result = [];
  for (let c = 0; c < available.length; c++) {
    if (!available[c] || c === 30 || own[c] >= available[c]) continue;
    const score = evaluate([...cards, c], p.groupCards, r, context(table, p, { heaven: false, earth: false }));
    if (score) result.push({ card: c, cardNum: Math.max(0, available[c] - own[c] - publicCounts[c]), FanNum: score.fan });
  }
  return result;
}
export function tingMap(table, p) {
  const r = rule(table), size = (r.family === 'jsmj' ? 5 : 14) - p.groupCards.length * 3;
  if (p.handCards.length === size - 1) return { '-1': waits(table, p) };
  if (p.handCards.length !== size) return {};
  const map = {};
  for (const c of new Set(p.handCards)) {
    if (!canDiscard(p, c)) continue;
    const cards = p.handCards.slice(); cards.splice(cards.indexOf(c), 1);
    const list = waits(table, p, cards); if (list.length) map[c] = list;
  }
  return map;
}
function canDiscard(p, c) {
  return p.handCards.includes(c) && (!p.queType || !p.handCards.some(c => tiles.suit(c) === p.queType) || tiles.suit(c) === p.queType)
    && (!p.ting || c === p.drawn);
}
function readyAfterKong(table, p, card, fromDiscard = false) {
  const old = p.groupCards.find(g => g.type === OP.PENG && g.card === card);
  const cards = p.handCards.slice(), needed = fromDiscard ? 3 : old ? 1 : 4;
  if (!tiles.contains(cards, Array(needed).fill(card))) return false;
  for (let i = 0; i < needed; i++) cards.splice(cards.indexOf(card), 1);
  const groups = p.groupCards.map(g => ({ ...g, cards: g.cards.slice() }));
  if (old) Object.assign(groups[p.groupCards.indexOf(old)], { type: OP.BU_GANG, cards: Array(4).fill(card) });
  else groups.push({ type: fromDiscard ? OP.DIAN_GANG : OP.AN_GANG, card, cards: Array(4).fill(card) });
  return waits(table, { ...p, groupCards: groups }, cards).length > 0;
}
function prompt(io, table, p) {
  const h = table.hand;
  io.broadcast(proto(table).turn, { uid: p.uid, pos: p.pos, opTime: h.rules.responseTime, hasPengGang: true });
  privateSend(io, p.uid, proto(table).event, { uid: p.uid, pos: p.pos, type: OP.PROMPT,
    handCards: p.handCards.slice(), groupCards: groupsFor(p, p.uid), cardLen: p.handCards.length,
    leftCardLen: left(h), opTime: h.rules.responseTime, operatorList: options(table, p) });
}
function offerSea(io, table, p, now) {
  const h = table.hand;
  h.actorUid = p.uid; h.seaPassed ||= [];
  setClock(h, 'sea', now, h.rules.responseTime * 1000);
  h.offers = { [p.uid]: [{ type: OP.DRAW }, { type: OP.PASS }] }; prompt(io, table, p);
}
function takeSea(io, table, p, now) {
  const h = table.hand, tile = add(h, p);
  p.drawn = tile.card; p.drawCount++; p.passedHu = false; h.seaUid = p.uid;
  setClock(h, 'turn', now, h.rules.opTime * 1000); h.offers = {};
  const score = evaluate(p.handCards, p.groupCards, h.rules, context(table, p));
  // Taking the final tile resolves immediately: either a self-drawn sea hu,
  // or the mandatory sea discard. No chi/peng/kong window remains.
  if (score) {
    event(io, table, p, OP.DRAW, { card: tile.card, isHaiDiCard: true, isHaiDiKeepSelf: true });
    win(io, table, [p], null, now); return;
  }
  remove(p, [tile.card]); h.publicIndices.add(tile.index); p.playCards.push(tile.card); p.drawn = null;
  h.lastOut = { uid: p.uid, card: tile.card };
  event(io, table, p, OP.DRAW, { card: tile.card, isHaiDiCard: true, isHaiDiKeepSelf: false });
  if (!openResponse(io, table, p, tile.card, now)) settle(io, table, now);
}
function drawGangTail(io, table, p, now) {
  const h = table.hand;
  p.ting = true; p.afterKong = true; p.drawn = null;
  h.actorUid = p.uid; h.gangTail = [];
  for (let i = 0; i < 4 && left(h); i++) {
    const tile = takeWall(h, true); h.gangTail.push(tile); h.publicIndices.add(tile.index);
  }
  const winners = h.gangTail.filter(t => evaluate([...p.handCards, t.card], p.groupCards, h.rules, context(table, p)));
  if (!winners.length) { discardGangTail(io, table, p, now); return; }
  setClock(h, 'gang', now, h.rules.responseTime * 1000);
  h.offers = { [p.uid]: [...winners.map(t => ({ type: OP.HU, card: t.card })), { type: OP.PASS }] };
  prompt(io, table, p);
}
function discardGangTail(io, table, p, now) {
  const h = table.hand, cards = h.gangTail.map(t => t.card);
  p.playCards.push(...cards); h.discardCount += cards.length; p.discardCount += cards.length;
  h.batchOut = cards; h.lastOut = { uid: p.uid, card: cards[0] };
  event(io, table, p, 13, { gangTailCards: cards, gangTailDiscardCards: cards });
  const offers = {};
  for (const card of cards) for (const [uid, list] of Object.entries(responseOffers(table, p, card))) {
    for (const op of list.filter(o => o.type === OP.HU)) {
      offers[uid] ||= [];
      if (!offers[uid].some(o => o.card === card)) offers[uid].push(op);
    }
  }
  for (const uid of Object.keys(offers)) offers[uid].push({ type: OP.PASS });
  if (!openResponse(io, table, p, cards[0], now, false, offers)) {
    h.batchOut = null; h.gangTail = null; startTurn(io, table, next(h, p), now);
  }
}
function groupsFor(p, uid) {
  return p.groupCards.map(g => g.type === OP.AN_GANG && p.uid !== Number(uid)
    ? { ...g, card: -1, cards: [-1, -1, -1, -1] } : { ...g, cards: g.cards.slice() });
}
function memberView(table, p, uid) {
  const mine = p.uid === Number(uid);
  return { uid: p.uid, pos: p.pos, ...(mine ? { handCards: p.handCards.slice() } : { cardLen: p.handCards.length }),
    groupCards: groupsFor(p, uid), playCards: p.playCards.slice(), flowerNum: p.flowers, ting: p.ting,
    tingIndex: p.ting ? 1 : 0, queType: table.hand.stage === 'que' && !mine ? 0 : p.queType || 0, huRecord: structuredClone(p.huRecord),
    point: p.member.point, score: p.delta, changeCards: [], operatorList: mine ? options(table, p) : [],
    tingListMap: mine ? tingMap(table, p) : {} };
}
export function snapshot(table, session, now = Date.now()) {
  const h = table.hand, uid = Number(session.userId);
  if (!h) return null;
  const memberDeskInfos = h.players.map(p => memberView(table, p, uid));
  const state = h.rules.family === 'hzxl' ? { deal: 1, exchange: 2, que: 3, first: 4, turn: 4, response: 4 } : { deal: 1, first: 2, turn: 3, response: 3 };
  return { currentInning: table.currentInning, inningState: state[h.stage] || 3, bankerPos: h.bankerPos,
    memberDeskInfos, curOpUid: h.actorUid || 0, opUids: h.stage === 'response' ? Object.keys(h.offers).map(Number).filter(id => !h.responses[id]) : [h.actorUid].filter(Boolean),
    cursorUid: h.actorUid || 0, leftTime: Math.max(0, h.rules.family === 'hzxl' ? h.deadline - now : Math.ceil((h.deadline - now) / 1000)),
    ...(h.stage === 'turn' && h.actorUid === uid && player(table, uid).drawn != null ? { drawCard: player(table, uid).drawn } : {}),
    leftCardLen: left(h), addFanCard: h.addFanCard, hasOperator: true, hasPengGang: h.stage === 'response',
    lastOutUid: h.lastOut?.uid || 0, lastOutCard: h.lastOut?.card ?? -1,
    queTypeMap: Object.fromEntries(h.players.map(p => [p.uid, h.stage === 'que' && p.uid !== uid ? 0 : p.queType || 0])),
    selectedQueType: player(table, uid)?.queType || 0, recommendQueType: robot.chooseQue(player(table, uid)?.handCards || []),
    changeCardInfo: { changeCardUids: h.players.map(p => p.uid), doneUids: h.players.filter(p => p.exchange).map(p => p.uid), cards: player(table, uid)?.exchange || [] },
    baseSuggest1: 10, baseSuggest2: 9, addSuggestList: [], tianTingPos: [], tianTingOpPos: [],
    isHuakaiFuGui: false };
}
export function pushSnapshot(send, table, session) {
  if (!table.hand) return;
  table.hand.viewers.add(Number(session.userId)); fair.watchFairHand(table, session.userId);
  send(proto(table).snapshot, snapshot(table, session));
}
function event(io, table, p, type, data = {}) {
  const h = table.hand;
  h.events.push({ uid: p.uid, pos: p.pos, type, card: data.card ?? -1, inningRound: h.discardCount,
    ...(type === OP.DRAW ? { drawCard: data.card ?? -1 } : {}),
    paiList: p.handCards.slice(), groupCards: structuredClone(p.groupCards), time: h.time });
  each(io, (uid, send) => {
    const mine = Number(uid) === p.uid;
    send(proto(table).event, { uid: p.uid, pos: p.pos, type, card: type === OP.DRAW && !mine ? -1 : data.card ?? -1,
      leftCardLen: left(h), cardLen: p.handCards.length, groupCards: groupsFor(p, uid),
      ...(['csmj', 'hzxl'].includes(h.rules.family) ? { handCards: mine ? p.handCards.slice() : Array(p.handCards.length).fill(-1) } : {}),
      ting: p.ting, tingIndex: p.ting ? 1 : 0, flowerNum: p.flowers, isFlower: false, isLastCard: left(h) === 0,
      hasPengGang: h.stage === 'response', opTime: Math.max(0, h.rules.family === 'hzxl' ? h.deadline - h.time : Math.ceil((h.deadline - h.time) / 1000)),
      ...data, ...([OP.DRAW, OP.AN_GANG].includes(type) && !mine ? { card: -1 } : {}),
      ...(mine ? { operatorList: options(table, p), tingListMap: tingMap(table, p) } : {}) });
  });
}
function setClock(h, stage, now, duration) {
  h.stage = stage; h.time = now; h.deadline = now + duration;
  for (const p of h.players) p.actionAt = now + Math.min(robot.thinkTime(), Math.max(100, duration - 250));
}
export function begin(io, table, now = Date.now(), deckOverride) {
  if (table.hand) return false;
  const r = table.roomRules, members = table.members.filter(m => m.point >= r.carryMin && !m.carryDeadline && !m.pendingDeparture).sort((a, b) => a.pos - b.pos);
  if (members.length !== r.gameStartNum) { table.phase = 'idle'; return false; }
  const deck = deckOverride || tiles.shuffled(tiles.deckFor(r));
  if (!tiles.validDeck(deck, r)) throw new Error('Invalid Mahjong wall');
  table.currentInning++; table.phase = 'playing'; table.roomState = 3;
  const bankerPos = members.some(m => m.pos === table.dealerPos) ? table.dealerPos : members[0].pos;
  const h = table.hand = { rules: structuredClone(r), deck, index: 0, tailIndex: deck.length, bankerPos,
    // The original Changsha help draws birds from a separate deck. Fix them
    // before play; bird draws must not consume the main wall or its sea tile.
    birdCards: r.family === 'csmj' ? tiles.shuffled(tiles.deckFor(r)).slice(0, 2) : [],
    addFanCard: r.family === 'jsmj' ? (r.maxPeople === 2 ? 18 : 0) + randomInt(r.maxPeople === 2 ? 12 : 30) : -1,
    players: members.map(m => { m.state = 3; m.totalBet = 0; return { uid: m.uid, pos: m.pos, bot: m.bot, member: m, name: m.name, icon: m.icon,
      openingPoint: m.point, handCards: [], indices: [], groupCards: [], playCards: [], flowers: 0,
      huRecord: [], details: [], delta: 0, totalFan: 0, roots: 0, redKongs: 0,
      ting: false, queType: 0, drawCount: 0, discardCount: 0, passedHu: false, claimedSmalls: [] }; }),
    events: [], publicIndices: new Set(), discardCount: 0, winners: [], offers: {}, responses: {},
    viewers: new Set([...(table.observers || []), ...members].map(m => Number(m.uid))) };
  // Commit the entire physical wall before dealing. Repeated faces have
  // independent keys; only physically revealed indices are disclosed later.
  features.beginHandStats(table, h.players); fair.beginFairHand(io, table, h.players, 0);
  const size = r.family === 'jsmj' ? 4 : 13;
  for (const p of h.players) {
    while (p.handCards.length < size) add(h, p);
    sort(p);
  }
  const banker = h.players.find(p => p.pos === bankerPos);
  let drawn; do { drawn = add(h, banker); } while (drawn.flower);
  banker.drawn = drawn.card;
  h.actorUid = banker.uid;
  setClock(h, 'deal', now, r.dealTimeMs);
  io.broadcast(3261, { currentInning: table.currentInning, uidList: members.map(m => m.uid), playMode: r.playMode, roomStart: true });
  if (r.family === 'csmj') io.broadcast(4209, { bankerPos, uid: banker.uid });
  each(io, (uid, send) => send(proto(table).deal, { bankerPos, players: h.players.map(p => memberView(table, p, uid)), leftCardLen: left(h), addFanCard: h.addFanCard, isHuakaiFuGui: false }));
  return true;
}
export function options(table, p) {
  const h = table.hand, r = rule(table);
  if (!h || h.settled) return [];
  if (h.stage === 'response') return h.responses[p.uid] ? [] : h.offers[p.uid] || [];
  if (h.stage === 'first') return h.responses[p.uid] ? [] : h.offers[p.uid] || [];
  if (['sea', 'gang'].includes(h.stage)) return h.actorUid === p.uid ? h.offers[p.uid] || [] : [];
  if (h.stage !== 'turn' || h.actorUid !== p.uid) return [];
  if (r.family === 'hzxl' && p.passedTurnActions) return [];
  const list = [];
  const score = !p.passedHu && evaluate(p.handCards, p.groupCards, r, context(table, p));
  if (score) list.push({ type: OP.HU, card: p.drawn ?? p.handCards.at(-1),
    ...(r.family === 'hzxl' ? { num: score.fan, huType: score.base.huType } : {}) });
  const c = tiles.counts(p.handCards), canKong = left(h) >= (r.family === 'csmj' ? 4 : 1);
  if ((canKong || r.family === 'csmj' && left(h)) && (!p.ting || r.family === 'csmj')) for (let card = 0; card < (r.family === 'jsmj' ? 30 : 27); card++) {
    if (tiles.suit(card) === p.queType) continue;
    const type = c[card] === 4 ? OP.AN_GANG : c[card] && p.groupCards.some(g => g.card === card && g.type === OP.PENG) ? OP.BU_GANG : null;
    if (!type) continue;
    if (canKong && (r.family !== 'csmj' || readyAfterKong(table, p, card))) list.push({ type, card });
    if (r.family === 'csmj' && !p.ting) list.push({ type: OP.BU, card });
  }
  if (r.family === 'csmj' && left(h) > 1) {
    const smalls = p.drawCount > 0 ? smallHu(p.handCards, true).filter(t => !p.claimedSmalls.includes(t)
      && c[p.drawn] === (t === 101 ? 4 : 3)) : [];
    if (smalls.length) list.push({ type: OP.MID_HU, huTypes: smalls });
  }
  if (r.family === 'jsmj' && !p.ting && Object.keys(tingMap(table, p)).length) {
    list.push({ type: h.discardCount === 0 ? OP.FIRST : OP.TING, cards: Object.keys(tingMap(table, p)).map(Number) });
  }
  // DISCARD is an internal choice. Original clients infer its legality from
  // the current turn; only actual buttons are serialized in operatorList.
  if (r.family === 'hzxl' && list.length) list.push({ type: OP.PASS });
  return list;
}
function pushOperationHint(io, table, p) {
  if (rule(table).family !== 'hzxl') return;
  privateSend(io, p.uid, 3868, { uid: p.uid, card: p.drawn ?? -1, operatorList: options(table, p) });
}
function startTurn(io, table, p, now, draw = true) {
  const h = table.hand, r = rule(table);
  p.passedTurnActions = false;
  h.actorUid = p.uid; h.offers = {}; h.responses = {}; h.pendingKong = null;
  setClock(h, 'turn', now, r.opTime * 1000);
  if (draw && r.family === 'csmj' && left(h) === 1) { offerSea(io, table, p, now); return; }
  if (draw) {
    let tile;
    do {
      tile = add(h, p);
      if (!tile) { settle(io, table, now); return; }
      if (tile.flower) event(io, table, p, OP.DRAW, { card: 30, isFlower: true, opTime: 1 });
    } while (tile.flower);
    p.drawn = tile.card; p.drawCount++; p.passedHu = false;
  }
  if (r.family === 'jsmj' && p.flowers === 4) { win(io, table, [p], null, now, { flowerWin: true }); return; }
  if (r.family !== 'hzxl') io.broadcast(proto(table).turn,
    { uid: p.uid, pos: p.pos, opTime: r.opTime, hasPengGang: false });
  event(io, table, p, OP.DRAW, { card: p.drawn ?? -1 });
  // Blood-flow checks hand length and enables input only on 3852, after
  // 3853 has rendered the draw, including the banker's first discard.
  if (r.family === 'hzxl') io.broadcast(proto(table).turn,
    { opUids: [p.uid], opTime: r.opTime * 1000, cursorUid: p.uid });
  // The blood-flow operation panel listens to 3868, independently of the
  // operatorList carried by the draw animation in 3853.
  pushOperationHint(io, table, p);
  if (r.family === 'csmj') pushTingState(io, table, p);
}
function pushTingState(io, table, p) {
  const map = tingMap(table, p), list = Object.values(map).flat(), canQueryTing = list.length > 0;
  const big = list.some(t => t.FanNum > 1), first = canQueryTing && !p.tingNotified;
  privateSend(io, p.uid, 4211, { uid: p.uid, canQueryTing, defaultOutCard: Number(Object.keys(map)[0] ?? -1),
    tingListMap: map, isFirstBigHuTing: first && big, isFirstSmallHuTing: first && !big });
  if (first) p.tingNotified = true;
}
function beginFirst(io, table, now) {
  const h = table.hand, r = rule(table);
  h.offers = {}; h.responses = {};
  if (r.family === 'jsmj') {
    const flowerWinner = h.players.find(p => p.flowers === 4);
    if (flowerWinner) { win(io, table, [flowerWinner], null, now, { flowerWin: true }); return; }
    for (const p of h.players.filter(p => p.pos !== h.bankerPos)) {
      if (waits(table, p).length) h.offers[p.uid] = [{ type: OP.FIRST }, { type: OP.PASS }];
    }
  } else for (const p of h.players) {
    const huTypes = smallHu(p.handCards);
    if (huTypes.length) h.offers[p.uid] = [{ type: OP.FIRST, huTypes }, { type: OP.PASS }];
  }
  if (!Object.keys(h.offers).length) { startTurn(io, table, player(table, h.actorUid), now, false); return; }
  setClock(h, 'first', now, r.responseTime * 1000);
  each(io, (uid, send) => {
    const p = player(table, uid);
    if (r.family === 'jsmj') send(proto(table).first, { tianTingPos: Object.keys(h.offers).map(id => player(table, id).pos), opTime: r.responseTime,
      uid, operatorList: p ? options(table, p) : [], tingListMap: p ? tingMap(table, p) : {} });
    else if (p && h.offers[uid]) send(proto(table).event, { uid, pos: p.pos, type: 20, operatorList: options(table, p),
      handCards: p.handCards.slice(), groupCards: [], leftCardLen: left(h), opTime: r.responseTime });
  });
}
export function exchange(io, table, uid, cards, now = Date.now()) {
  const h = table.hand, p = player(table, uid);
  if (!h || h.stage !== 'exchange' || now >= h.deadline || !p || p.exchange || !Array.isArray(cards) || cards.length !== 3
    || !tiles.contains(p.handCards, cards) || tiles.suit(cards[0]) === 4 || !cards.every(c => tiles.suit(c) === tiles.suit(cards[0]))) return false;
  p.exchange = cards.slice();
  each(io, (viewer, send) => send(3862, { uid: p.uid, changed: true, cardCount: 3, ...(viewer === p.uid ? { cards: cards.slice() } : {}) }));
  if (h.players.every(p => p.exchange)) {
    const outgoing = h.players.map(p => ({ cards: p.exchange, indices: remove(p, p.exchange) }));
    for (let i = 0; i < h.players.length; i++) {
      const target = h.players[i], sourceIndex = (i + h.players.length - 1) % h.players.length, from = outgoing[sourceIndex];
      target.handCards.push(...from.cards); target.indices.push(...from.indices); sort(target);
      target.receivedExchange = from.cards.slice(); target.exchangeSource = h.players[sourceIndex].uid;
      if (target.uid === h.actorUid && !target.handCards.includes(target.drawn)) target.drawn = target.handCards.at(-1);
    }
    setClock(h, 'que', now, h.rules.prepareTimeMs);
    each(io, (viewer, send) => {
      const me = player(table, viewer);
      send(3860, { uid: viewer, needChangeCard: true, dingQueTime: h.rules.prepareTimeMs,
        ...(me ? { cards: me.exchange.slice(), exchangeCards: me.receivedExchange.slice(), recommendQueType: robot.chooseQue(me.handCards),
          handCards: me.handCards.slice(), changeCardUid: me.exchangeSource } : {}) });
    });
  }
  return true;
}
export function chooseQue(io, table, uid, type, now = Date.now()) {
  const h = table.hand, p = player(table, uid);
  if (!h || h.stage !== 'que' || now >= h.deadline || !p || p.queType || ![1, 2, 3].includes(type)) return false;
  p.queType = type; privateSend(io, uid, 3863, { uid: p.uid, type, queType: type });
  if (h.players.every(p => p.queType)) {
    io.broadcast(3861, { queTypeMap: Object.fromEntries(h.players.map(p => [p.uid, p.queType])), baseSuggest1: 10, baseSuggest2: 9, addSuggest: [] });
    startTurn(io, table, player(table, h.actorUid), now, false);
  }
  return true;
}
function responseOffers(table, source, card, robKong = false) {
  const h = table.hand, r = rule(table), offers = {};
  for (const p of h.players) {
    if (p === source) continue;
    const list = [], score = evaluate([...p.handCards, card], p.groupCards, r, context(table, p,
      { selfDraw: false, heaven: false, earth: false, afterKong: false, robKong, kongDiscard: source.afterKong }));
    if (r.family !== 'jsmj' && !p.passedHu && score && (!robKong || r.family === 'csmj') && (r.family !== 'hzxl' || score.fan >= 128)) list.push({ type: OP.HU, card,
      ...(r.family === 'hzxl' ? { num: score.fan, huType: score.base.huType } : {}) });
    if (!robKong && !p.ting && !(r.family === 'csmj' && h.seaUid && !left(h)) && !(r.family === 'hzxl' && (card === 27 || tiles.suit(card) === p.queType))) {
      const n = p.handCards.filter(c => c === card).length;
      if (n >= 2) list.push({ type: OP.PENG, card });
      if (n >= 3 && left(h) >= (r.family === 'csmj' ? 4 : 1) && (r.family !== 'csmj' || readyAfterKong(table, p, card, true))) list.push({ type: OP.DIAN_GANG, card });
      if (n >= 3 && r.family === 'csmj' && left(h) >= 1) list.push({ type: OP.BU, card });
      if (r.family === 'csmj' && next(h, source) === p && card < 27) {
        const pairs = [];
        for (let start = Math.max(Math.floor(card / 9) * 9, card - 2); start <= card && start % 9 <= 6; start++) {
          const use = [start, start + 1, start + 2].filter(c => c !== card);
          if (tiles.contains(p.handCards, use)) pairs.push(use);
        }
        if (pairs.length) list.push({ type: OP.CHI, card, cards: pairs });
      }
    }
    if (list.length) offers[p.uid] = [...list, { type: OP.PASS }];
  }
  return offers;
}
function openResponse(io, table, source, card, now, robKong = false, offers) {
  const h = table.hand;
  h.offers = offers || responseOffers(table, source, card, robKong); h.responses = {};
  if (!Object.keys(h.offers).length) return false;
  setClock(h, 'response', now, h.rules.responseTime * 1000);
  io.broadcast(proto(table).turn, h.rules.family === 'hzxl'
    ? { opUids: Object.keys(h.offers).map(Number), cursorUid: source.uid, opTime: h.rules.responseTime * 1000 }
    : { uid: source.uid, pos: source.pos, opTime: h.rules.responseTime, hasPengGang: true });
  for (const uid of Object.keys(h.offers)) {
    const p = player(table, uid), payload = { uid: p.uid, pos: p.pos, type: h.rules.family === 'csmj' ? OP.PROMPT : 9,
      card, operatorList: h.offers[uid], handCards: p.handCards.slice(), groupCards: groupsFor(p, p.uid),
      leftCardLen: left(h), cardLen: p.handCards.length, opTime: h.rules.responseTime * (h.rules.family === 'hzxl' ? 1000 : 1), hasPengGang: true };
    privateSend(io, p.uid, proto(table).event, payload);
    if (h.rules.family === 'hzxl') privateSend(io, p.uid, 3868, { uid: p.uid, operatorList: h.offers[uid] });
  }
  return true;
}
function closeOp(io, table, p, type, auto = false) {
  if (rule(table).family === 'csmj') privateSend(io, p.uid, 4213, { uid: p.uid, operationType: type, timeoutAuto: auto });
  if (rule(table).family === 'hzxl') privateSend(io, p.uid, 3868, { uid: p.uid, operatorList: [] });
}
function finishResponses(io, table, now) {
  const h = table.hand;
  if (Object.keys(h.offers).some(uid => !h.responses[uid])) return;
  if (h.stage === 'first') {
    if (h.rules.family === 'csmj') {
      const declared = Object.entries(h.responses).filter(([, a]) => a.type === OP.FIRST);
      for (const [uid] of declared) smallAward(io, table, player(table, uid), h.offers[uid].find(o => o.type === OP.FIRST).huTypes, now,
        declared.length > 1 ? h.bankerPos : player(table, uid).pos);
    }
    startTurn(io, table, player(table, h.actorUid), now, false); return;
  }
  const winners = Object.entries(h.responses).filter(([, a]) => a.type === OP.HU).map(([uid]) => player(table, uid));
  const source = player(table, h.lastOut.uid);
  if (winners.length) {
    const winCards = h.batchOut ? Object.fromEntries(winners.map(p => [p.uid, h.batchOut.filter(card =>
      evaluate([...p.handCards, card], p.groupCards, h.rules, context(table, p, { selfDraw: false, heaven: false, earth: false, afterKong: false, kongDiscard: true })))])) : null;
    win(io, table, winners, source, now, { robKong: !!h.pendingKong, winCards }); return;
  }
  if (h.pendingKong) { const { p, card } = h.pendingKong; performKong(io, table, p, OP.BU_GANG, card, now); return; }
  const priority = type => type === OP.CHI ? 1 : [OP.PENG, OP.DIAN_GANG, OP.BU].includes(type) ? 2 : 0;
  const order = p => (h.players.indexOf(p) - h.players.indexOf(source) + h.players.length) % h.players.length;
  const chosen = Object.entries(h.responses).map(([uid, op]) => ({ p: player(table, uid), op }))
    .filter(x => priority(x.op.type)).sort((a, b) => priority(b.op.type) - priority(a.op.type) || order(a.p) - order(b.p))[0];
  if (!chosen) { source.afterKong = false; h.batchOut = null; h.gangTail = null; startTurn(io, table, next(h, source), now); return; }
  const { p, op } = chosen;
  source.playCards.pop();
  if ([OP.DIAN_GANG, OP.BU].includes(op.type)) { performKong(io, table, p, op.type, op.card, now, source); return; }
  const use = op.type === OP.PENG ? [op.card, op.card] : op.chiUseCards;
  const indices = remove(p, use); indices.forEach(i => h.publicIndices.add(i));
  const cards = [...use, op.card].sort((a, b) => a - b);
  p.groupCards.push({ card: op.card, cards, indices, type: op.type, num: 3, playId: source.uid, posUid: source.uid,
    posDesc: (source.pos - p.pos + h.rules.maxPeople) % h.rules.maxPeople });
  h.actorUid = p.uid; p.drawn = null; p.passedTurnActions = false;
  setClock(h, 'turn', now, h.rules.opTime * 1000); h.offers = {}; h.responses = {};
  event(io, table, p, op.type, { card: op.card, outCardUid: source.uid, chiUseCards: use });
  io.broadcast(proto(table).turn, h.rules.family === 'hzxl' ? { opUids: [p.uid], cursorUid: p.uid, opTime: h.rules.opTime * 1000 }
    : { uid: p.uid, pos: p.pos, opTime: h.rules.opTime, hasPengGang: false });
  pushOperationHint(io, table, p);
}
function performKong(io, table, p, type, card, now, source = null) {
  const h = table.hand, supplement = type === OP.BU;
  const old = p.groupCards.find(g => g.type === OP.PENG && g.card === card);
  const taken = remove(p, Array(source ? 3 : old ? 1 : 4).fill(card));
  if (source || old || supplement) taken.forEach(i => h.publicIndices.add(i));
  const actual = source ? OP.DIAN_GANG : old ? OP.BU_GANG : OP.AN_GANG;
  if (old) { old.type = actual; old.cards.push(card); old.num = 4; old.indices.push(...taken); }
  else p.groupCards.push({ card, cards: [card, card, card, card], indices: taken, type: actual, num: 4,
    playId: source?.uid || p.uid, posUid: source?.uid || p.uid, posDesc: source ? (source.pos - p.pos + h.rules.maxPeople) % h.rules.maxPeople : 0 });
  if (h.rules.family === 'hzxl') p.roots++;
  if (h.rules.family === 'jsmj') transfer((source ? [source] : h.players.filter(x => x !== p)).map(from => ({ from, to: p,
    amount: h.rules.diFen * (source ? h.rules.maxPeople === 2 ? 1 : 3 : actual === OP.AN_GANG ? 2 : 1) })), 2, '杠分');
  p.afterKong = !supplement; h.pendingKong = null;
  event(io, table, p, type, { card, dianGangUid: source?.uid || 0, outCardUid: source?.uid || 0 });
  if (h.rules.family === 'csmj' && !supplement) { drawGangTail(io, table, p, now); return; }
  startTurn(io, table, p, now, true);
}
function smallAward(io, table, p, types, now, anchorPos = p.pos) {
  const h = table.hand;
  // Faces 5/6 are rerolled according to the help. Sampling 1..4 directly
  // gives the same distribution and guarantees bounded work.
  const dice = [1 + randomInt(4), 1 + randomInt(4)];
  const hits = pos => dice.filter(d => (anchorPos + d - 1) % h.rules.maxPeople === pos).length;
  for (const type of types) {
    transfer(h.players.filter(x => x !== p).map(from => ({ from, to: p, amount: h.rules.diFen
      * ((p.pos === h.bankerPos || from.pos === h.bankerPos ? 2 : 1) + hits(p.pos) + hits(from.pos)) })), types[0] > 100 ? 4 : 3, types[0] > 100 ? '中途胡' : '起手胡');
    p.claimedSmalls.push(type);
  }
  // Expose only the tiles used by a declared small hand, never its entire
  // concealed hand (que-yi-se/banbanhu necessarily certify the whole hand).
  const c = tiles.counts(p.handCards);
  const show = types.some(t => [3, 4, 5, 8].includes(t)) ? p.handCards.slice()
    : p.handCards.filter(t => types.some(x => x === 1 || x === 101 ? c[t] === 4 : x === 2 || x === 102 ? c[t] >= 3 : c[t] >= 2));
  for (let i = 0; i < p.handCards.length; i++) if (show.includes(p.handCards[i])) h.publicIndices.add(p.indices[i]);
  const hitPlayers = h.players.map(other => { const hitCards = dice.filter(d => (anchorPos + d - 1) % h.rules.maxPeople === other.pos);
    return { uid: other.uid, hitCards, hitCount: hitCards.length }; });
  const detail = { uid: p.uid, showHuCards: show, huInfos: types.map(huTypeCode => ({ huTypeCode, fan: 1 })), dices: dice, hitPlayers, anchorPos };
  const key = types[0] > 100 ? 'midHuHitInfoMap' : 'qiShouHuHitInfoMap';
  (h[key] ||= {})[p.uid] = structuredClone(detail);
  io.broadcast(4210, [detail]);
  h.events.push({ uid: p.uid, pos: p.pos, type: types[0] > 100 ? OP.MID_HU : OP.FIRST, huTypes: types, cards: show,
    paiList: p.handCards.slice(), groupCards: structuredClone(p.groupCards), inningRound: h.discardCount, time: now });
}
export function action(io, table, uid, body = {}, now = Date.now()) {
  const h = table.hand, p = player(table, uid), type = body.type, card = body.card;
  if (!h || h.settled || !p || now >= h.deadline || !Number.isInteger(type) || (body.uid != null && Number(body.uid) !== p.uid)) return false;
  const r = h.rules;
  if (h.stage === 'sea') {
    if (p.uid !== h.actorUid || ![OP.DRAW, OP.PASS].includes(type)) return false;
    closeOp(io, table, p, type);
    if (type === OP.DRAW) takeSea(io, table, p, now);
    else { h.seaPassed.push(p.uid); if (h.seaPassed.length === h.players.length) settle(io, table, now); else offerSea(io, table, next(h, p), now); }
    return true;
  }
  if (h.stage === 'gang') {
    if (p.uid !== h.actorUid || !options(table, p).some(o => o.type === type && (o.card == null || o.card === card))) return false;
    closeOp(io, table, p, type);
    if (type === OP.HU) win(io, table, [p], null, now, { winCards: { [p.uid]: h.gangTail.filter(t =>
      evaluate([...p.handCards, t.card], p.groupCards, r, context(table, p))).map(t => t.card) } });
    else discardGangTail(io, table, p, now);
    return true;
  }
  if (h.stage === 'response' || h.stage === 'first') {
    const offered = h.offers[p.uid];
    if (!offered || h.responses[p.uid]) return false;
    const op = offered.find(o => o.type === type && (o.card == null || o.card === card));
    if (!op) return false;
    let use;
    if (type === OP.CHI) {
      const supplied = body.chiUseCards;
      if (!Array.isArray(supplied)) return false;
      const pair = op.cards.find(pair => supplied.length === 2 ? pair.every(c => supplied.includes(c)) : supplied.length === 1 && pair[0] === supplied[0]);
      if (!pair) return false; use = pair.slice();
    }
    if (h.stage === 'first' && type === OP.FIRST) {
      if (r.family === 'jsmj') { p.ting = true; p.heavenTing = true; event(io, table, p, type); }
      // Changsha declarations are paid after all players choose, so the
      // multi-winner dice anchor cannot depend on response arrival order.
    }
    if (type === OP.PASS && offered.some(o => o.type === OP.HU)) p.passedHu = true;
    h.responses[p.uid] = { type, card, chiUseCards: use };
    closeOp(io, table, p, type, body.isAuto);
    finishResponses(io, table, now); return true;
  }
  if (h.stage !== 'turn' || h.actorUid !== p.uid) return false;
  const offered = options(table, p);
  if (type !== OP.DISCARD && type !== OP.PASS && !offered.some(o => o.type === type && (o.card == null || o.card === card))) return false;
  if (type === OP.PASS) {
    if (offered.some(o => o.type === OP.HU)) p.passedHu = true;
    if (r.family === 'hzxl') p.passedTurnActions = true;
    closeOp(io, table, p, type); return true;
  }
  if (type === OP.HU) { closeOp(io, table, p, type); win(io, table, [p], null, now); return true; }
  if (type === OP.MID_HU) { smallAward(io, table, p, offered.find(o => o.type === type).huTypes, now); closeOp(io, table, p, type); return true; }
  if ([OP.AN_GANG, OP.BU_GANG, OP.BU].includes(type)) {
    closeOp(io, table, p, type);
    if (type === OP.BU_GANG && r.family === 'csmj') {
      h.lastOut = { uid: p.uid, card }; h.pendingKong = { p, card };
      if (openResponse(io, table, p, card, now, true)) return true;
    }
    performKong(io, table, p, type, card, now); return true;
  }
  if (![OP.DISCARD, OP.TING, OP.FIRST].includes(type) || !Number.isInteger(card) || !canDiscard(p, card)) return false;
  if ([OP.TING, OP.FIRST].includes(type)) {
    if (r.family !== 'jsmj' || !tingMap(table, p)[card]?.length) return false;
    p.ting = true; p.heavenTing = type === OP.FIRST;
  }
  const index = remove(p, [card])[0]; h.publicIndices.add(index);
  p.playCards.push(card); p.discardCount++; h.discardCount++; h.lastOut = { uid: p.uid, card };
  closeOp(io, table, p, type);
  // The client indexes its rendered concealed hand, not the discard pile.
  // Let it locate the face because its local hand sorting is independent.
  event(io, table, p, type, { card });
  p.drawn = null;
  if (r.family === 'hzxl' && card === 27) { p.redKongs++; p.afterKong = true; startTurn(io, table, p, now, true); return true; }
  if (!openResponse(io, table, p, card, now)) { p.afterKong = false; startTurn(io, table, next(h, p), now); }
  return true;
}
function win(io, table, winners, source, now, extra = {}) {
  const h = table.hand, r = h.rules, claims = [], results = [];
  if (extra.robKong) remove(source, [h.lastOut.card]).forEach(index => h.publicIndices.add(index));
  let birds = [];
  if (r.family === 'csmj') {
    birds = h.birdCards.slice();
  }
  if (r.family === 'jsmj') {
    // User requirement: bonus award probability is zero until its detailed
    // rules are supplied. Keep the native reveal animation with no reward.
    h.last5Cards = [];
    for (let i = 0; i < 5 && left(h); i++) { const tile = takeWall(h); h.last5Cards.push(tile.card); h.publicIndices.add(tile.index); }
  }
  for (const p of winners) for (const card of extra.winCards?.[p.uid] || [source ? h.responses[p.uid]?.card ?? h.lastOut.card : p.drawn ?? p.handCards.at(-1)]) {
    const score = extra.flowerWin ? { fan: 200, types: [{ huType: 10, fan: 200 }], base: { huType: 10, fan: 200 }, additional: [] }
      : evaluate(source || extra.winCards ? [...p.handCards, card] : p.handCards, p.groupCards, r, context(table, p, { ...extra, selfDraw: !source, heaven: !source && h.discardCount === 0 && p.pos === h.bankerPos,
        earth: !source && p.pos !== h.bankerPos && p.drawCount === 1 && p.discardCount === 0, afterKong: !source && p.afterKong, kongDiscard: !!source?.afterKong }));
    if (!score) throw new Error('Mahjong winning hand changed after validation');
    const paidBy = source ? [source] : h.players.filter(x => x !== p);
    const anchor = winners.length > 1 ? h.bankerPos : p.pos;
    const hit = pos => birds.filter(c => (anchor + tiles.rank(c) - 1) % r.maxPeople === pos).length;
    const record = { card, baseType: { fanType: score.base.huType, fanNum: score.base.fan },
      additionalTypes: score.additional.map(t => ({ fanType: t.huType, fanNum: t.fan })), ziMo: !source,
      posDesc: source ? (source.pos - p.pos + r.maxPeople) % r.maxPeople : 0, dianPaoUid: source?.uid || 0, totalFan: score.fan, score: 0 };
    for (const from of paidBy) claims.push({ from, to: p, record, amount: r.diFen * score.fan * (r.family === 'csmj' ? 1 + hit(p.pos) + hit(from.pos) : 1) });
    p.huRecord.push(record); p.huCard = card; p.finalHu = score; results.push({ p, score, record });
    if (!h.winners.includes(p.uid)) h.winners.push(p.uid);
  }
  const paid = transfer(claims);
  if (r.family === 'hzxl') {
    // A winning physical tile moves to the hu display, out of the concealed
    // hand/discard pile, before the client rebuilds its hand after the hu.
    const winning = source ? h.lastOut.card : winners[0].huCard;
    if (source) source.playCards.pop();
    else { const index = remove(winners[0], [winning])[0]; h.publicIndices.add(index); }
    (h.revealedWinTiles ||= []).push(winning);
  }
  for (const { p, score, record } of results) {
    record.score = paid.filter(c => c.record === record).reduce((n, c) => n + c.amount, 0); p.totalFan += score.fan;
    event(io, table, p, OP.HU, { card: record.card, outCardUid: source?.uid || 0, huRecord: structuredClone(p.huRecord),
      score: record.score, totalFan: score.fan,
      totalScoreMap: Object.fromEntries(h.players.map(p => [p.uid, p.delta])),
      huScoreMap: Object.fromEntries(h.players.map(p => [p.uid, paid.reduce((n, c) => n + (c.to === p ? c.amount : c.from === p ? -c.amount : 0), 0)])),
      curPointMap: Object.fromEntries(h.players.map(p => [p.uid, p.member.point])),
      winHuTypes: score.types, finalHuInfo: { huTypeCodes: score.types.map(t => t.huType), huTypeList: score.types } });
  }
  h.birds = birds; h.lastWinUid = winners[0].uid; h.winSourceUid = source?.uid || 0;
  const anchorPos = winners.length > 1 ? h.bankerPos : winners[0].pos;
  h.birdAnchorPos = anchorPos;
  h.birdPlayers = h.players.map(p => { const hitCards = birds.filter(c => (anchorPos + tiles.rank(c) - 1) % r.maxPeople === p.pos);
    return { uid: p.uid, hitCount: hitCards.length, hitCards }; });
  if (r.family !== 'hzxl') { settle(io, table, now); return; }
  for (const p of winners) { p.drawn = null; p.afterKong = false; }
  const from = source || winners[0]; from.afterKong = false;
  startTurn(io, table, next(h, from), now, true);
}
export function settle(io, table, now = Date.now()) {
  const h = table.hand; if (!h || h.settled) return false;
  const r = h.rules;
  if (r.family === 'hzxl') {
    const ready = new Map(h.players.map(p => [p, waits(table, p)]));
    const claims = [];
    for (const from of h.players) {
      const pig = from.handCards.some(c => tiles.suit(c) === from.queType);
      from.isHuaZhu = pig;
      if (pig || !ready.get(from).length) for (const to of h.players) {
        const list = ready.get(to);
        if (to !== from && list.length) claims.push({ from, to, amount: r.diFen * Math.max(...list.map(t => t.FanNum)) * (pig ? 2 : 1) });
      }
    }
    transfer(claims, 6, '查叫');
  }
  h.settled = true;
  const results = h.players.map(p => {
    const take = p.delta > 0 ? Math.floor(p.delta * r.taxPercent / 10000) : 0;
    p.member.point -= take; p.member.state = 2;
    const score = p.delta - take;
    const categoryScore = category => p.details.filter(d => d.category === category).reduce((n, d) => n + d.score, 0);
    const huScore = categoryScore(5), startHuScore = categoryScore(3), midHuScore = categoryScore(4),
      flowerFan = categoryScore(1) / r.diFen, gangFan = categoryScore(2) / r.diFen;
    p.indices.forEach(index => h.publicIndices.add(index));
    for (const g of p.groupCards) for (const index of g.indices || []) h.publicIndices.add(index);
    return { uid: p.uid, pos: p.pos, name: p.member.name, icon: p.member.icon,
      handCards: p.handCards.slice(), groupCards: structuredClone(p.groupCards), huRecord: structuredClone(p.huRecord),
      huCard: p.huCard ?? null, innerStartPoint: p.openingPoint, innerEndPoint: p.member.point,
      point: p.member.point, score, finallyScore: score, finalHuScore: huScore,
      totalFan: r.family === 'jsmj' ? huScore / r.diFen : p.totalFan, flowerFan, gangFan, xiaZhuData: p.member.totalBet || 0,
      startHuScore, midHuScore, startHuFan: startHuScore / r.diFen, midHuFan: midHuScore / r.diFen,
      finalHuFan: huScore / r.diFen, finalHuInfo: { huTypeCodes: p.finalHu?.types.map(t => t.huType) || [], huTypeList: p.finalHu?.types || [],
        huOperateCode: 0, huOperateDesc: p.huRecord.length ? '胡牌' : '', huTypeDesc: '', operationType: p.huRecord.at(-1)?.ziMo ? 1 : 2 },
      flowerNum: p.flowers, contribute: 0, take, winLoseStatus: p.huRecord.length ? h.winSourceUid ? 3 : 1 : p.uid === h.winSourceUid ? 2 : 0,
      queType: p.queType, isTing: waits(table, p).length > 0, isHuaZhu: !!p.isHuaZhu, scoreDetailList: structuredClone(p.details),
      zhaNiaoCards: h.birds || [], zhaNiaoPlayers: structuredClone(h.birdPlayers || []),
      zhaNiaoHitCount: h.birdPlayers?.find(x => x.uid === p.uid)?.hitCount || 0,
      publicDeckIndices: [...h.publicIndices] };
  });
  const payload = { resultList: results, playerList: results, winUid: h.lastWinUid || 0, leftCardLen: left(h), bankerPos: h.bankerPos,
    drawCardUid: h.lastWinUid || 0, drawCard: h.players.find(p => p.uid === h.lastWinUid)?.huCard ?? -1,
    outCardUid: h.winSourceUid || 0, cards: h.winSourceUid ? h.players.filter(p => h.winners.includes(p.uid)).flatMap(p => p.huRecord.map(record => record.card)) : [],
    qiShouHuHitInfoMap: h.qiShouHuHitInfoMap || {}, midHuHitInfoMap: h.midHuHitInfoMap || {},
    addFanCard: h.addFanCard, last5Cards: h.last5Cards || h.birds || [], zhaNiaoCards: h.birds || [], zhaNiaoPlayers: h.birdPlayers || [],
    zhaNiaoAnchorPos: h.birdAnchorPos || 0,
    fanjiangCards: [], fanjiangScore: 0, fanjiangFan: 0, addCardFan: 0,
    winHuTypes: h.players.find(p => p.uid === h.lastWinUid)?.finalHu?.types || [],
    huTotalFan: h.players.find(p => p.uid === h.lastWinUid)?.finalHu?.fan || 0,
    finalHuScoreMap: Object.fromEntries(results.map(p => [p.uid, p.finalHuScore])),
    finalHuFanMap: Object.fromEntries(results.map(p => [p.uid, p.finalHuFan])),
    startHuScoreMap: Object.fromEntries(results.map(p => [p.uid, p.startHuScore])),
    midHuScoreMap: Object.fromEntries(results.map(p => [p.uid, p.midHuScore])),
    startHuFanMap: Object.fromEntries(results.map(p => [p.uid, p.startHuFan])),
    midHuFanMap: Object.fromEntries(results.map(p => [p.uid, p.midHuFan])),
    zhaNiaoHitCountMap: Object.fromEntries(results.map(p => [p.uid, p.zhaNiaoHitCount])) };
  // Settlement releases all remaining hands, not future wall tiles.
  io.broadcast(proto(table).settle, payload);
  table.taxCollected = (table.taxCollected || 0) + results.reduce((n, p) => n + p.take, 0);
  features.finishHandStats(table, results); fair.finishFairHand(table, results);
  history?.record(table, h, payload);
  features.pushRanking({ table, io });
  table.lastMahjongResult = payload;
  table.dealerPos = h.lastWinUid ? h.players.find(p => p.uid === h.lastWinUid).pos : next(h, h.players.find(p => p.pos === h.bankerPos)).pos;
  table.hand = null; table.phase = 'idle'; table.roomState = 1; table.startAt = now + 5000;
  return true;
}
export function tick(io, table, now = Date.now()) {
  const h = table.hand; if (!h) return;
  if (h.stage === 'deal') {
    if (now < h.deadline) return;
    if (h.rules.family === 'hzxl') { setClock(h, 'exchange', now, h.rules.prepareTimeMs); io.broadcast(3859, { uids: h.players.map(p => p.uid), time: h.rules.prepareTimeMs }); }
    else beginFirst(io, table, now);
    return;
  }
  for (const p of h.players) {
    if (table.hand !== h) return;
    const due = now >= h.deadline, auto = isAuto(p) && now >= p.actionAt;
    // The original blood-flow client locks hand input after the first hu.
    // Keep optional buttons available, then draw-discard without waiting for
    // the human's full timeout or using a bot to rearrange the waiting hand.
    const lockedHand = h.rules.family === 'hzxl' && p.huRecord.length > 0;
    const autoDiscard = lockedHand && h.stage === 'turn' && h.actorUid === p.uid
      && now >= p.actionAt && options(table, p).length === 0;
    if (!due && !auto && !autoDiscard) continue;
    const at = Math.min(now, h.deadline - 1);
    if (h.stage === 'exchange' && !p.exchange) exchange(io, table, p.uid, robot.chooseExchange(p.handCards), at);
    else if (h.stage === 'que' && !p.queType) chooseQue(io, table, p.uid, robot.chooseQue(p.handCards), at);
    else if (['gang', 'sea'].includes(h.stage) && h.actorUid === p.uid) {
      const chosen = auto ? robot.chooseAction({ cards: p.handCards.slice(), options: options(table, p), family: h.rules.family }) : { type: OP.PASS };
      action(io, table, p.uid, chosen, at);
    }
    else if ((h.stage === 'response' || h.stage === 'first') && h.offers[p.uid] && !h.responses[p.uid]) {
      const chosen = auto ? robot.chooseAction({ cards: p.handCards.slice(), options: options(table, p), family: h.rules.family }) : { type: OP.PASS };
      action(io, table, p.uid, { ...chosen, isAuto: true }, at);
    } else if (h.stage === 'turn' && h.actorUid === p.uid) {
      const chosen = lockedHand && (due || autoDiscard) && p.handCards.includes(p.drawn)
        ? { type: OP.DISCARD, card: p.drawn }
        : robot.chooseAction({ cards: p.handCards.slice(), options: due ? [] : [...options(table, p), { type: OP.DISCARD }],
        family: h.rules.family, queType: p.queType, ting: p.ting, drawn: p.drawn,
        publicCards: h.players.flatMap(p => p.playCards.concat(p.groupCards.flatMap(g => g.type === 4 ? [] : g.cards))) });
      // Declaration buttons in Jsmj require the actual discard, not the
      // entire list of candidate discards returned with the hint.
      if ([OP.TING, OP.FIRST].includes(chosen.type) && chosen.card == null) chosen.card = chosen.cards?.[0];
      action(io, table, p.uid, { ...chosen, isAuto: true }, at);
      p.actionAt = now + Math.min(robot.thinkTime(), Math.max(100, h.deadline - now - 250));
    }
  }
}
export function historyPayload(table, body, uid) {
  return history?.query(table, body, uid) || { gameRoomId: table.roomId, totalNum: 0, playBackList: [], isOfflineData: false };
}
export const historyDetail = (...args) => history?.historyDetail(...args) || null;
export function recorder(table, uid) {
  const p = player(table, uid), r = rule(table), full = tiles.counts(tiles.deckFor(r));
  const seen = tiles.counts((p?.handCards || []).concat(table.hand?.revealedWinTiles || [], table.hand?.players.flatMap(other => other.playCards.concat(
    other.groupCards.flatMap(g => g.type === OP.AN_GANG && other !== p ? [] : g.cards))) || []));
  return { cardCountMap: Object.fromEntries(full.slice(0, r.family === 'hzxl' ? 28 : 30).map((n, i) => [i, Math.max(0, n - seen[i])])) };
}
