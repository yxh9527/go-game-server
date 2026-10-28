import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldemGame } from '../../../../game-server/src/games/holdem/HoldemGame.js';
import { beginHand, createTexasTable, onTexasAction, pushPlayingSnapshot, texasConf,
  texasHistoryDetail, texasHistoryPayload } from '../../../../game-server/src/games/holdem/engine.js';
import { initializeCritical, nextHandRules } from '../../../../game-server/src/games/holdem/critical.js';
import { OP } from '../../../../game-server/src/games/holdem/op.js';
import { PUSH } from '../../../../game-server/src/messages.js';

function fixture({ show = false, due = true, stacks = [1000, 1000, 1000], ante = 100 } = {}) {
  const cfg = { room_type: 19, game_room_config_id: show ? 1921 : 1928, play_mode: 2,
    small_blind: 10, big_blind: 20, carry_min: 500, force_show_card: Number(show),
    payload: JSON.stringify({ criticalAnte: ante, criticalInterval: '5-8' }) };
  const table = new HoldemGame().createTable(700051, 19, cfg);
  table.members = stacks.map((point, pos) => ({ uid: pos + 1, name: 'p' + pos, pos, point, state: 1 }));
  table.criticalAt = Date.now() + (due ? -1 : 300_000);
  const messages = [];
  const io = { env: 'dev', broadcast(msgid, payload) { messages.push({ msgid, payload }); },
    send(uid, msgid, payload) { messages.push({ uid, msgid, payload }); },
    sendUser(uid, msgid, payload) { messages.push({ uid, msgid, payload }); },
    forEachPlayer(fn) { for (const uid of [1, 2, 3, 99]) fn({ userId: uid, ws: uid }); } };
  return { table, io, messages };
}
function finish(f) {
  for (let n = 0; f.table.hand && n < 50; n++) {
    const hand = f.table.hand, actor = f.table.members.find(p => p.uid === hand.actorUid);
    assert.ok(actor && !actor.allIn);
    onTexasAction(f.io, f.table, { userId: actor.uid },
      { operation: actor.streetBet < hand.currentBet ? OP.FOLLOW : OP.PASS });
  }
  assert.equal(f.table.hand, null);
  return f.messages.findLast(m => m.msgid === PUSH.DZPK_INNING_RESULT_PUSH).payload;
}
test('critical timer uses minutes, persists through reload and room idle time, and coalesces overdue intervals', async () => {
  const f = fixture(), t = f.table;
  delete t.criticalAt; initializeCritical(t);
  assert.ok(t.criticalAt >= t.createdAt + 300_000 && t.criticalAt <= t.createdAt + 480_000);
  const at = t.criticalAt;
  const reloaded = await import('../../../../game-server/src/games/holdem/critical.js?v=critical-regression');
  reloaded.initializeCritical(t); assert.equal(t.criticalAt, at);
  assert.equal(nextHandRules(t, at - 1).playMode, 0);
  assert.equal(t.criticalAt, at);
  assert.deepEqual(nextHandRules(t, at), { critical: true, playMode: 2, initialBet: 100 });
  assert.ok(t.criticalAt >= at + 300_000 && t.criticalAt <= at + 480_000);
  assert.equal(nextHandRules(t, at).critical, false);
  const wake = t.criticalAt + 10_000_000;
  assert.equal(nextHandRules(t, wake).critical, true);
  assert.ok(t.criticalAt >= wake + 300_000);
  const isolated = fixture(); assert.notEqual(isolated.table.criticalAt, t.criticalAt);
});
test('captured hand 227: mandatory ante only, no blinds or preflop betting, first actor is small blind', () => {
  const f = fixture(); beginHand(f.io, f.table);
  const begin = f.messages.find(m => m.msgid === PUSH.NIUNIU_CURRENT_INNING_BEGIN_INFO).payload;
  assert.equal(texasConf(f.table).playMode, 3); assert.equal(begin.playMode, 2);
  assert.equal(begin.initialBet, 100); assert.equal(begin.bigBlind, 20);
  assert.equal(f.table.hand.pot, 300); assert.equal(f.table.hand.street, 'BET_FLOP');
  assert.equal(f.table.hand.actorUid, f.table.hand.smallBlindId);
  assert.deepEqual(f.table.members.map(p => [p.point, p.totalBet, p.streetBet]),
    [[900,100,0],[900,100,0],[900,100,0]]);
  const states = f.messages.filter(m => m.msgid === PUSH.BRNN_GAME_STATE_PUSH).map(m => m.payload);
  assert.deepEqual(states, ['BET_FRONT','DEAL_PERFLOP','DEAL_FLOP','BET_FLOP']);
  assert.ok(!f.messages.some(m => m.msgid === PUSH.DZPK_ACTION_BET_PUSH && m.payload.operation === OP.BLIND));
  const privateOptions = f.messages.filter(m => m.msgid === PUSH.DZPK_OPERATION_PUSH);
  assert.ok(privateOptions.length); assert.ok(privateOptions.every(m => m.uid === f.table.hand.actorUid));
  const dealt = f.messages.filter(m => m.msgid === PUSH.DZPK_DEAL_DI_PUSH && m.uid === 99);
  assert.ok(dealt[0].payload.every(p => p.cardList.every(c => c === -1)));
});
test('ordinary hands inside a critical room retain configured ante, blinds and preflop action', () => {
  const f = fixture({due:false}); const at = f.table.criticalAt; beginHand(f.io, f.table);
  assert.equal(f.table.hand.playMode, 0); assert.equal(f.table.hand.initialBet, 20);
  assert.equal(f.table.hand.street, 'BET_PERFLOP'); assert.equal(f.table.hand.pot, 90);
  assert.equal(f.table.criticalAt, at); finish(f);
  f.table.criticalAt = Date.now() - 1; beginHand(f.io, f.table);
  assert.equal(f.table.hand.playMode, 2); finish(f);
  beginHand(f.io, f.table); assert.equal(f.table.hand.playMode, 0);
});
test('critical short stacks are all-in capped, finish automatically and conserve all chips', () => {
  for (const stacks of [[30,70,1000],[30,70,100],[1,2,3]]) {
    const f = fixture({stacks}); beginHand(f.io, f.table);
    assert.equal(f.table.hand, null);
    const results = f.messages.find(m => m.msgid === PUSH.DZPK_INNING_RESULT_PUSH).payload;
    assert.equal(results.reduce((sum,p) => sum + p.score, 0), 0);
    assert.equal(f.table.members.reduce((sum,p) => sum + p.point, 0), stacks.reduce((a,b)=>a+b,0));
    assert.ok(results.every(p => Number.isSafeInteger(p.point) && p.point >= 0));
    assert.equal(f.table.history[0].firstGameList[0].commonPoker.length, 5);
    assert.deepEqual(results.map(p => p.xiaZhuData), stacks.map(p => Math.min(100,p)));
  }
});
test('critical reconnect and replay preserve per-hand mode and ante and do not change timer', () => {
  const f = fixture({ante:700}); beginHand(f.io, f.table); const at = f.table.criticalAt;
  const recovery=[]; pushPlayingSnapshot((msgid,payload)=>recovery.push({msgid,payload}),f.table,{userId:99});
  const state=recovery.find(m=>m.msgid===PUSH.NIUNIU_INNING_BEGIN_INFO).payload;
  assert.equal(state.playMode,2); assert.equal(state.initialBet,700);
  assert.ok(state.memberDeskInfos.every(p=>p.handPais.every(c=>c===-1)));
  assert.equal(f.table.criticalAt,at); const results=finish(f);
  assert.equal(results.reduce((sum,p)=>sum+p.score,0),0);
  const replay=texasHistoryPayload(f.table).playBackList[0];
  assert.equal(replay.playMode,2);assert.equal(replay.initialBet,700);
  const detail=texasHistoryDetail(f.table,1).exploitsInfoMsgs[0];
  const conf=JSON.parse(detail.gameRoomUnion.roomConfig);
  assert.equal(conf.dzpkParams.initialBet,700);assert.equal(conf.dzpkParams.criticalFlag,true);
  assert.equal(JSON.parse(detail.inningInfo).playMode,2);
  assert.ok(!JSON.parse(detail.roundList).some(a=>a.gameState===4));
});
test('critical no-show folded holes remain hidden; forced-show reveals them at settlement', () => {
  for (const show of [false,true]) {
    const f=fixture({show});beginHand(f.io,f.table);const uid=f.table.hand.actorUid;
    onTexasAction(f.io,f.table,{userId:uid},{operation:OP.ABANDON});
    const results=finish(f), folded=results.find(p=>p.uid===uid);
    assert.equal(folded.showCards.length,show?2:0);
    const replay=texasHistoryPayload(f.table).playBackList[0].firstGameList.find(p=>p.uid===uid);
    assert.equal(replay.showCards.every(c=>c>=0),show);
  }
});
test('payload-only critical settings and invalid rules are validated before a room can play', () => {
  const cfg={room_type:19,payload:JSON.stringify({playMode:2,criticalAnte:450,criticalInterval:'2-4',
    smallBlind:30,bigBlind:60,carryMin:800,initialBet:0,forceShowCard:true})};
  for (const table of [new HoldemGame().createTable(1,19,cfg),createTexasTable(1,19,cfg)]) {
    assert.equal(table.playMode,3);assert.equal(table.criticalAnte,450);assert.equal(table.initialBet,0);
    assert.equal(table.bigBlind,60);assert.equal(table.forceShowCard,true);
  }
  for(const fields of [{criticalAnte:0},{criticalAnte:-1},{criticalAnte:NaN},{criticalInterval:'8-5'},
    {criticalInterval:'0'},{criticalInterval:'NaN'},{criticalInterval:'1-999'}]) {
    assert.throws(()=>new HoldemGame().createTable(1,19,{...cfg,payload:JSON.stringify({playMode:2,criticalAnte:100,criticalInterval:'5-8',...fields})}),/Invalid Holdem/);
  }
});
