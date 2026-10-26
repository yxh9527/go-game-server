import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { ZjhGame } from '../../../../game-server/src/games/zjh/ZjhGame.js';
import { ZJH_OP as OP, ZJH_PUSH as MSG } from '../../../../game-server/src/games/zjh/messages.js';
import * as engine from '../../../../game-server/src/games/zjh/engine.js';
import { compareWithSuit, evaluate3 } from '../../../../game-server/src/games/zjh/hand.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';

function fixture(count = 3, cfg = {}) {
  const game = new ZjhGame();
  const table = game.createTable(25010000, 25, { ante: 10, carry_min: 100, ...cfg });
  table.members = Array.from({ length: count }, (_, i) => ({ uid: i + 1, pos: i, point: 1000, name: 'p' + i }));
  table.observers = [{ uid: 99 }];
  const messages = [];
  const io = { env: 'dev', broadcast(id, data) { messages.push({ id, data: structuredClone(data) }); },
    sendUser(uid, id, data) { messages.push({ uid, id, data: structuredClone(data) }); } };
  engine.beginHand(io, table);
  const act = (op, data, extra = {}, uid = table.hand.actorUid) => engine.onZjhAction(io, table,
    { userId: uid }, { operation: op, ...(data == null ? {} : { operationData: data }), ...extra });
  const roundTwo = () => { while (table.hand?.round === 1) act(OP.CALL); };
  return { game, table, messages, io, act, roundTwo };
}

test('client action constants, round payload, deal privacy and action recipients match the wire contract', () => {
  assert.deepEqual([OP.ANTE, OP.FOLD, OP.CALL, OP.RAISE, OP.SHOW, OP.ALL_IN, OP.LOOK, OP.COMPARE, OP.DISUSE, OP.FOLLOW_ALWAYS],
    [1,2,3,4,5,6,7,8,9,10]);
  const f = fixture();
  assert.ok(f.messages.find((m) => m.id === 3261).data.uidList.length === 3);
  assert.equal(f.messages.find((m) => m.id === MSG.ROUND_INFO).data, 1);
  assert.ok(f.messages.find((m) => m.id === MSG.DEAL_DI).data.every((p) => p.cardList.every((c) => c === -1)));
  const options = f.messages.find((m) => m.id === MSG.OPERATION);
  assert.equal(options.uid, f.table.hand.actorUid);
  assert.ok(options.data.every((o) => Number.isFinite(o.data.score) && typeof o.data.isEnable === 'boolean'));
  assert.ok(!f.messages.some((m) => [MSG.OPERATION, MSG.PRE_OPERATION].includes(m.id) && (!m.uid || m.uid === 99)));
});

test('calls complete a circle instead of settling, look doubles the next cost without extending the clock', () => {
  const f = fixture();
  f.roundTwo();
  assert.equal(f.table.hand.round, 2);
  const uid = f.table.hand.actorUid, before = f.table.hand.deadline;
  f.act(OP.LOOK);
  assert.equal(f.table.hand.deadline, before);
  assert.equal(f.messages.find((m) => m.id === MSG.SEE_CARD).uid, uid);
  const p = f.table.members.find((p) => p.uid === uid);
  assert.equal(engine.callAmount(f.table, p), 20);
  const point = p.point;
  f.act(OP.CALL, 0.2);
  assert.equal(p.point, point - 20);
  assert.equal(f.messages.filter((m) => m.id === MSG.ACTION_BET).at(-1).data.currentBetScore, 20);
});

test('unknown, nonfinite, spoofed and stale amount actions cannot move chips or turn', () => {
  const f = fixture();
  const initial = JSON.stringify(f.table);
  for (const data of [NaN, Infinity, -1, 0, 100, 'invalid']) f.act(OP.CALL, data);
  f.act(900); f.act(OP.CALL, 0.1, { uid: 99 }); f.act(OP.CALL, 0.1, {}, 99);
  f.act(OP.LOOK); // First circle is mandatory blind.
  assert.equal(JSON.stringify(f.table), initial);
});

test('compare uses targetUid, validates it before payment, resolves suits and marks loser as disused', () => {
  const f = fixture(); f.roundTwo(); f.act(OP.LOOK);
  const actor = f.table.members.find((p) => p.uid === f.table.hand.actorUid);
  const target = f.table.members.find((p) => p !== actor);
  actor.hole = [39, 12, 24]; target.hole = [26, 25, 11]; // Equal A,K,Q; spade ace wins.
  const pot = f.table.hand.pot;
  for (const id of [99, actor.uid, -1]) f.act(OP.COMPARE, 0, { targetUid: id });
  assert.equal(f.table.hand.pot, pot);
  f.act(OP.COMPARE, 0, { targetUid: target.uid });
  assert.equal(f.table.hand.pot, pot + 40);
  assert.ok(target.folded);
  assert.equal(target.lastOperation, OP.DISUSE);
  const compare = f.messages.find((m) => m.id === MSG.BIPAI_RESULT).data;
  assert.equal(compare.target, target.uid);
  assert.equal(compare.winner, actor.uid);
  assert.ok(compareWithSuit(evaluate3(actor.hole), evaluate3(target.hole)) > 0);
});

test('folding and removed seats preserve committed chips and all participant results', () => {
  const f = fixture();
  const departed = f.table.members.find((p) => p.uid === f.table.hand.actorUid);
  engine.foldIfPlaying(f.io, f.table, departed.uid);
  const cash = departed.point;
  f.table.members = f.table.members.filter((p) => p !== departed);
  while (f.table.hand) f.act(OP.CALL);
  const results = f.messages.find((m) => m.id === MSG.INNING_RESULT).data;
  assert.equal(results.length, 3);
  assert.equal(results.find((p) => p.uid === departed.uid).score, -10);
  assert.equal(results.reduce((sum, p) => sum + p.score, 0), 0);
  assert.equal(f.table.members.reduce((sum, p) => sum + p.point, cash), 3000);
  assert.equal(f.table.roomFeatures.players.get(departed.uid).totalHands, 1);
  assert.equal(f.table.roomFeatures.totalHands, 1);
});

test('short stack all-in completes with finite nonnegative balances and conserved chips', () => {
  const f = fixture(3);
  const p = f.table.members.find((p) => p.uid === f.table.hand.actorUid);
  const removed = p.point - 5; p.point = 5;
  f.act(OP.ALL_IN, 0);
  assert.equal(p.point, 0);
  let turns = 0;
  while (f.table.hand && turns++ < 100) f.act(OP.CALL);
  assert.ok(turns < 100);
  assert.equal(f.table.members.reduce((s, p) => s + p.point, removed), 3000);
  const result = f.messages.find((m) => m.id === MSG.INNING_RESULT).data;
  assert.equal(result.reduce((s, p) => s + p.score, 0), 0);
});

test('follow-always toggles a preselection and does not fold or pay on the setting message', () => {
  const f = fixture(2), p = f.table.members[0];
  const point = p.point;
  f.act(OP.FOLLOW_ALWAYS, 0, {}, p.uid);
  assert.equal(p.point, point); assert.equal(p.folded, false); assert.equal(p.followAlways, true);
  f.act(OP.FOLLOW_ALWAYS, 0, {}, p.uid);
  assert.equal(p.followAlways, false);
});

test('actor never receives waiting controls on turns, look, toggle or reconnect', () => {
  const f = fixture();
  const check = () => {
    const actor = f.table.hand.actorUid;
    assert.ok(f.messages.some(m => m.id === MSG.OPERATION && m.uid === actor));
    assert.ok(!f.messages.some(m => m.id === MSG.PRE_OPERATION && m.uid === actor));
    for (const p of f.table.members.filter(p => p.uid !== actor)) {
      assert.ok(f.messages.some(m => m.id === MSG.PRE_OPERATION && m.uid === p.uid));
    }
  };
  check();
  while (f.table.hand.round === 1) {
    f.messages.length = 0;
    f.act(OP.CALL);
    check();
  }
  f.messages.length = 0;
  f.act(OP.LOOK);
  check();
  const actor = f.table.hand.actorUid;
  f.messages.length = 0;
  f.act(OP.FOLLOW_ALWAYS);
  assert.ok(!f.messages.some(m => m.id === MSG.PRE_OPERATION && m.uid === actor));
  for (const uid of [...f.table.members.map(p => p.uid), 99]) {
    const frames = [];
    engine.pushPlayingSnapshot((id, data) => frames.push({ id, data }), f.table, { userId: uid });
    assert.equal(frames.some(m => m.id === MSG.OPERATION), uid === actor);
    assert.equal(frames.some(m => m.id === MSG.PRE_OPERATION), uid !== actor && uid !== 99);
  }
  const waiting = f.table.members.find(p => p.uid !== actor);
  f.messages.length = 0;
  f.act(OP.FOLLOW_ALWAYS, 0, {}, waiting.uid);
  assert.equal(f.messages.at(-1).id, MSG.PRE_OPERATION);
  assert.equal(f.messages.at(-1).data[0].data.isEnable, true);
  waiting.point = 0;
  const frames = [];
  engine.pushPlayingSnapshot((id, data) => frames.push({ id, data }), f.table, { userId: waiting.uid });
  assert.ok(!frames.some(m => m.id === MSG.PRE_OPERATION));
});

test('reconnect snapshot supplies pot and own looked cards; observers and fair codes keep hidden cards private', () => {
  const f = fixture(2, { force_show_card: 0 }); f.roundTwo(); f.act(OP.LOOK);
  const uid = f.table.hand.actorUid;
  const frames = [];
  engine.pushPlayingSnapshot((id, data) => frames.push({ id, data }), f.table, { userId: uid });
  const snapshot = frames.find((m) => m.id === 3260).data;
  assert.equal(snapshot.pot, f.table.hand.pot);
  assert.deepEqual(snapshot.memberDeskInfos.find((p) => p.uid === uid).handPais, f.table.members.find((p) => p.uid === uid).hole);
  assert.ok(snapshot.memberDeskInfos.find((p) => p.uid !== uid).handPais.every((c) => c === -1));
  for (const p of f.table.members) assert.equal(f.game.roomInfo(f.table).memberList.find((s) => s.uid === p.uid).point - p.totalBet, p.point);
  frames.length = 0;
  engine.pushPlayingSnapshot((id, data) => frames.push({ id, data }), f.table, { userId: 99 });
  assert.ok(frames.find((m) => m.id === 3260).data.memberDeskInfos.every((p) => p.handPais.every((c) => c < 0)));
  assert.ok(!frames.some((m) => m.id === MSG.OPERATION));
  f.act(OP.FOLD);
  assert.ok(f.messages.find((m) => m.id === MSG.INNING_RESULT).data.every((p) => p.handPais.length === 0));
  assert.ok(fairCodeDetail(f.table, 99, 1).pokerList.every((p) => p.secretKey === ''));
});

test('replay detail preserves ordered circles, profiles and three-card hands, pages are isolated by viewer', () => {
  const f = fixture();
  while (f.table.hand) f.act(OP.CALL);
  engine.beginHand(f.io, f.table);
  f.act(OP.FOLD); f.act(OP.FOLD);
  const page = (n, uid = 99) => engine.historyPayload(f.table, { beginNum: n, endNum: n }, uid);
  assert.equal(page(0).playBackList[0].currentInningNum, 1);
  assert.equal(page(1).playBackList[0].currentInningNum, 2);
  assert.equal(page(0).totalNum, 2);
  assert.equal(page(0, 12345).playBackList.length, 0);
  assert.equal(engine.historyDetail(f.table, 1, 12345), null);
  const detail = engine.historyDetail(f.table, 1, 99).exploitsInfoMsgs[0];
  const results = JSON.parse(detail.inningResults), events = JSON.parse(detail.roundList);
  assert.ok(results.every((p) => p.name && p.icon && p.handPais.length === 3));
  assert.deepEqual([...new Set(events.map((e) => e.currentRounds))], [0,1,2,3,4,5,6,7,8]);
  assert.ok(events.every((e, i) => !i || e.pot >= events[i - 1].pot));
});

const bundle = fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/Zjh/index.df153.js', import.meta.url), 'utf8');
function originalMethod(name, globals) {
  const anchor = "['prototype']['" + name + "']=", start = bundle.indexOf(anchor) + anchor.length;
  const end = bundle.indexOf(",Y['prototype']", start);
  return vm.runInNewContext('(' + bundle.slice(start, end) + ')', globals);
}

test('original client action handler renders server amounts without NaN', () => {
  const f = fixture(); f.roundTwo();
  const p = f.table.members.find((p) => p.uid === f.table.hand.actorUid);
  const component = { interactable: true, node: {} };
  const node = () => ({ active: false, getComponent: () => component, getComponentInChildren: () => component,
    parent: { getComponentsInChildren: () => [] } });
  const ui = { actionBtns: node(), preActionToggles: { node: node() },
    preAbandonToggle: {}, preGendaodiToggle: {}, checkToShowPreActionTips() {},
    chipCountLb: { node: { parent: {} } }, btnPosition: Array.from({length: 10}, (_, n) => Array(n)),
    _actionBtnSort: [6,8,2,7,4,3,10], showSelfHead() {} };
  for (const key of ['qipai','bipai','look','cuopai','genzhu','jiazhu','gendaodi','allIn']) {
    ui[key + 'Btn'] = node(); ui[key + 'Label'] = {};
  }
  const room = { isLoginIngRoom: false, getTuoguan: () => false, getRoomInfo: () => ({ playMode: 3 }),
    getMyMemberInfo: () => p, getJoinGameMembers: () => f.table.members };
  const globals = { cc: { app: { gameRoom: room }, Button: {}, Canvas: { instance: { getComponentInChildren: () => ({ getSeatByUid: () => ({ clearActionStatus() {} }) }) } } },
    N: { default: {} }, B: { default: {} }, J: { default: { userData: { uid: p.uid } } },
    H: { default: { transformLmCoinTrue: (n) => String(n / 100) } }, K: { Zjh_audio: { ins: { caozuo() {} } } },
    M: { default: { pushDebugLog() {}, sendDebugLog(...args) { assert.fail(args.join(' ')); } } },
    R: { ZJH_BANDON: 2, ZJH_FOLLOW: 3, ZJH_ADD: 4, ZJH_SHOW: 5, ZJH_ALLIN: 6, ZJH_SEE_CARD: 7, ZJH_COMPARE_CARD: 8, ZJH_GENDAODI: 10 } };
  ui.hideBtns = originalMethod('hideBtns', globals);
  ui.preActionToggles.node.active = true; // Waiting panel from the previous player's turn.
  const render = () => {
    for (const m of f.messages.filter(m => m.uid === p.uid)) {
      if (m.id === MSG.OPERATION) originalMethod('refalshOperationBtns', globals).call(ui, structuredClone(m.data));
      if (m.id === MSG.PRE_OPERATION) originalMethod('refalshPreOperationBtns', globals).call(ui, m.data);
    }
  };
  render();
  assert.equal(ui.genzhuLabel.string, '0.1'); assert.equal(ui._reqCount, 0.2);
  assert.equal(ui.lookBtn.active, true); assert.equal(ui.jiazhuBtn.active, true);
  assert.equal(ui.actionBtns.active, true);
  assert.equal(ui.preActionToggles.node.active, false, '3726 must not be followed by actor 3780 that reopens the overlay');
  f.messages.length = 0;
  f.act(OP.LOOK);
  render();
  assert.equal(ui.lookBtn.active, false);
  assert.equal(ui.preActionToggles.node.active, false, 'looking at cards keeps only the action panel visible');
});

test('original common Zjh history model parses all circles and three-card settlement rows', () => {
  const f = fixture(); f.roundTwo(); f.act(OP.LOOK);
  while (f.table.hand) f.act(OP.CALL);
  const main = fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/main/index.88f4e.js', import.meta.url), 'utf8');
  const module = main.slice(main.indexOf("'HistoryModelBase':["));
  const anchor = "['prototype']['onPushRecordDetail']=", start = module.indexOf(anchor) + anchor.length;
  const end = module.indexOf(",z['prototype']", start);
  const parse = vm.runInNewContext('(' + module.slice(start, end) + ')');
  const detail = engine.historyDetail(f.table, 1, 99);
  const model = { gameRecordDetailMap: {}, _currentPlayBack: { pot: detail.exploitsInfoMsgs[0].pot } };
  parse.call(model, detail);
  assert.equal(model.inningResults.length, 3);
  assert.ok(model.inningResults.every((p) => p.handPais.length === 3 && p.icon && p.name));
  assert.equal(model._roundList.length, 9);
  assert.ok(model._roundList.every((round) => Number.isFinite(round.startPot) && round.list.length > 0));
});

test('archived Zjh actions render through the original history name formatter, including old records', () => {
  const f = fixture(); f.roundTwo(); f.act(OP.LOOK);
  while (f.table.hand) f.act(OP.CALL);
  const saved = JSON.stringify(f.table.history);
  f.table.members.forEach(p => { p.name = 'changed after hand'; });
  const main = fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/main/index.88f4e.js', import.meta.url), 'utf8');
  const source = main.slice(main.indexOf("'ZjhHisDetaiActItem':["));
  const extract = (text, anchor, end, globals = {}) => {
    const start = text.indexOf(anchor) + anchor.length;
    return vm.runInNewContext('(' + text.slice(start, text.indexOf(end, start)) + ')', globals);
  };
  const limitLabelCharacters = extract(main, "h['limitLabelCharacters']=", ",h['getComponentInSelfOrAncestors']");
  const globals = { cc: { Layout: {} },
    A: { SingleFactory: { getInstance: () => ({ getBankerUid: () => 0 }) } }, F: { ZjhHistoryModel: {} },
    B: { default: { limitLabelCharacters, colorFromHex: c => c } },
    D: { default: { getLangText: (_bundle, key) => key } },
    E: { default: { userData: { uid: 99 } } }, k: { ZJHGameOptNames: {} } };
  const render = extract(source, "L['prototype']['updateObject']=", ",L['prototype']['getFrameId']", globals);
  const setupName = extract(source, "L['prototype']['setupName']=", ",L['prototype']['onClickOpNd']", globals);
  const label = () => ({ node: { width: 100, x: 0 }, _forceUpdateRenderData() {} });
  const ui = { setupName, getFrameId: () => 0, opBgFrames: [], bankerNode: {}, nameLabel: label(),
    text: label(), amountLb: label(), potLab: label(), pkWinLoseLb: label(),
    opSprite: { node: { getComponent: () => ({}) } } };
  const events = JSON.parse(engine.historyDetail(f.table, 1, 99).exploitsInfoMsgs[0].roundList);
  const oldEvent = { ...events[0] }; delete oldEvent.nickName;
  assert.throws(() => render.call(ui, oldEvent), /trim is not a function/);
  for (const event of events) {
    assert.equal(event.nickName, 'p' + (event.uid - 1));
    render.call(ui, event);
    assert.equal(ui.nameLabel.string, event.nickName);
    assert.ok(!/NaN/.test(ui.amountLb.string + ui.potLab.string));
  }
  assert.equal(JSON.stringify(f.table.history), saved, 'queries do not rewrite saved hands');
  const p = f.table.history[0].players[0];
  p.userInfo.name = ''; p.name = null;
  const fallback = JSON.parse(engine.historyDetail(f.table, 1, 99).exploitsInfoMsgs[0].roundList).find(e => e.uid === p.uid);
  assert.equal(fallback.nickName, String(p.uid));
  render.call(ui, fallback);
});
