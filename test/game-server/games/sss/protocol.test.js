import test from 'node:test';
import assert from 'node:assert/strict';
import { SssGame } from '../../../../game-server/src/games/sss/SssGame.js';
import * as engine from '../../../../game-server/src/games/sss/engine.js';
import { PUSH, SEND } from '../../../../game-server/src/games/sss/messages.js';
import { deckFor, evaluate } from '../../../../game-server/src/games/sss/hand.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createRoomLogic } from '../../../../hall/src/rooms.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';

function fixture(mode = 0, deck = deckFor(mode)) {
  const game = new SssGame(), table = game.createTable(27010000, 27,
    { game_room_config_id: 2701, play_mode: mode, ante: 10, carry_min: 1000 });
  table.members = [1, 2, 3, 4].map((uid, pos) => ({ uid, pos, point: 10000, name: 'p' + uid, icon: '1', state: 2 }));
  table.observers = [{ uid: 99, name: 'watcher' }];
  const messages = [], sessions = [1,2,3,4,99].map(userId => ({ userId, ws: userId }));
  const emit = (uid,id,data) => messages.push({ uid,id,data:structuredClone(data) });
  const io = { env:'dev',broadcast:(id,data)=>emit(0,id,data), send:emit,sendUser:emit,
    forEachPlayer:fn=>sessions.forEach(fn) };
  engine.begin(io,table,1000,deck);
  return { game,table,messages,sessions,io };
}
function finish(f) {
  for (const p of f.table.hand.players) assert.ok(engine.arrange(f.io,f.table,p.uid,p.options[0]));
  engine.tick(f.io,f.table,f.table.hand.earliest+1000);
}
test('original 3901/3921 protocol protects other cards and observer arrangement UI', () => {
  const f=fixture(1);
  const observer=f.messages.find(m=>m.uid===99&&m.id===PUSH.DEAL).data;
  assert.equal(observer.length,4);
  assert.ok(observer.every(p=>p.cardList===null&&p.arrangementOptions===null));
  const mine=f.messages.find(m=>m.uid===1&&m.id===PUSH.DEAL).data;
  assert.equal(mine.find(p=>p.uid===1).cardList.length,13);
  assert.ok(mine.filter(p=>p.uid!==1).every(p=>p.cardList===null));
  assert.equal(f.game.buildConf(f.table).roomType,'sss');
  assert.equal(f.game.buildConf(f.table).sssParams.playerCount,4);
  assert.ok(!engine.arrange(f.io,f.table,99,f.table.hand.players[0].options[0]));
  assert.ok(!engine.arrange(f.io,f.table,1,{front:[99,99,99],middle:[],back:[]}));
  assert.ok(f.game.onMessage({table:f.table,session:{userId:1},io:f.io,send(){}},SEND.ARRANGE,f.table.hand.players[0].options[0]));
  assert.ok(!engine.arrange(f.io,f.table,1,f.table.hand.players[0].options[0]));
  const recovery=engine.snapshot(f.table,{userId:99});
  assert.ok(recovery.memberDeskInfos.every(p=>!p.evalResult&&p.frontCards.length===0));
});
test('settlement conserves chips, publishes animation structures and is idempotent', () => {
  const f=fixture();finish(f);
  assert.equal(f.table.members.reduce((s,p)=>s+p.point,0),40000);
  assert.ok(f.table.members.every(p=>Number.isSafeInteger(p.point)&&p.point>=0));
  const cmp=f.messages.find(m=>m.id===PUSH.COMPARE).data.compareResult;
  for(const p of f.table.hand.players){
    assert.equal(cmp.playerResults[p.uid].frontHand.cards.length,3);
    assert.equal(cmp.playerResults[p.uid].middleHand.cards.length,5);
    assert.equal(cmp.playerResults[p.uid].backHand.cards.length,5);
    assert.equal(Object.keys(cmp.compareResults[p.uid]).length,3);
    assert.ok(Number.isFinite(cmp.playerStatsMap[p.uid].score));
  }
  assert.equal(Object.values(cmp.scoreMap).reduce((s,n)=>s+n,0),0);
  const points=f.table.members.map(p=>p.point);
  assert.equal(engine.settle(f.io,f.table,10000),false);
  assert.deepEqual(f.table.members.map(p=>p.point),points);
  assert.equal(f.table.roomFeatures.totalHands,1);
  assert.equal(f.table.history.length,1);
  assert.ok(f.messages.findIndex(m=>m.id===PUSH.SETTLE)<f.messages.findIndex(m=>m.id===PUSH.COMPARE));
  assert.equal(engine.snapshot(f.table,{userId:99}).compareResult.playerResults[1].backHand.cards.length,5);
  assert.ok(fairCodeDetail(f.table,99,1).pokerList.filter(p=>p.secretKey).length>=52);
  engine.tick(f.io,f.table,f.table.hand.deadline);
  assert.equal(f.table.hand,null);
});
test('timeout uses same validated arrange action, no observer auto seating', () => {
  const f=fixture(1);engine.tick(f.io,f.table,200000);
  assert.ok(f.table.hand.settled);
  assert.ok(f.table.hand.players.every(p=>p.result&&!p.result.isWater));
  assert.ok(!f.table.members.some(p=>p.uid===99));
});
test('bankroll limits hold when simultaneous pair losses exceed opening balance', () => {
  const f=fixture();
  for(const p of f.table.hand.players)p.openingPoint=p.member.point=1;
  finish(f);assert.equal(f.table.members.reduce((s,p)=>s+p.point,0),4);
  assert.ok(f.table.members.every(p=>p.point>=0));
});
test('history carries native three-pile comparison details and enforces viewer/room scopes', () => {
  const f=fixture();finish(f);
  const record=engine.historyPayload(f.table,{},99);
  assert.equal(record.dataInfo.firstGameList.length,4);
  assert.equal(record.dataInfo.firstGameList[0].userName,'p1');
  assert.ok(record.dataInfo.firstGameList.every(p=>p.userIcon&&p.evalResult.frontHand.cards.length===3));
  assert.equal(Object.keys(record.dataInfo.compareResult.playerStatsMap).length,4);
  assert.equal(engine.historyPayload(f.table,{},999).dataInfo,null);
  assert.equal(engine.historyPayload(f.table,{roomId:88},99).dataInfo,null);
  assert.equal(engine.historyPayload(f.table,{inningNum:999},99).dataInfo,null);
  engine.tick(f.io,f.table,f.table.hand.deadline);engine.begin(f.io,f.table,35000,deckFor(0));finish(f);
  assert.equal(engine.historyPayload(f.table,{beginNum:0},99).dataInfo.currentInningNum,1);
  assert.equal(engine.historyPayload(f.table,{beginNum:1},99).dataInfo.currentInningNum,2);
});
test('all eight lobby tiers route strictly by mode, ante, classification and carry', () => {
  const rows=seedRooms().filter(r=>r.room_type===27);
  assert.equal(rows.length,8);
  const num=(v,d)=>v===undefined||v===''?d:Number.isNaN(Number(v))?d:Number(v);
  const logic=createRoomLogic({num,truthy:v=>[true,1,'1','true'].includes(v)});
  for(const r of rows){
    const p=JSON.parse(r.payload);
    assert.equal(logic.findRoom(rows,p).game_room_config_id,r.game_room_config_id);
    assert.equal(logic.enterRoomPayload(r,{},{}).key,p.key);
  }
  assert.equal(logic.findRoom(rows,{roomType:27,playMode:1,ante:999}),null);
});
test('natural special deals match the original auto-acknowledge and special-card animation contract', () => {
  const hole=[0,13,26,3,16,29,4,17,30,8,21,34,12];
  const f=fixture(0,[...hole,...deckFor(0).filter(c=>!hole.includes(c))]);
  const row=f.messages.find(m=>m.uid===1&&m.id===PUSH.DEAL).data.find(p=>p.uid===1);
  assert.ok(row.arrangementOptions[0].specialType);
  assert.equal(row.arrangementOptions[0].frontType,undefined,'original panel automatically submits specials');
  assert.equal(row.frontCards.length,3);assert.equal(row.middleCards.length,5);assert.equal(row.backCards.length,5);
  assert.ok(engine.arrange(f.io,f.table,1,row.arrangementOptions[0]));
  assert.equal(f.table.hand.players[0].result.hasSpecialType,true);
});
test('human sit/carry updates do not broadcast room or recovery snapshots over a live animation', () => {
  const f=fixture();f.table.members.pop();f.messages.length=0;
  const session={userId:77,name:'new player',wallet:10000};
  const emit=(id,data)=>f.messages.push({uid:77,id,data});
  f.game.onSitDown({table:f.table,session,body:{position:3},send:emit,io:f.io});
  assert.ok(f.table.members.find(p=>p.uid===77)?.carryDeadline>0);
  assert.ok(f.messages.some(m=>m.uid===0&&m.id===2202&&m.data.uid===77));
  assert.ok(!f.messages.some(m=>m.id===2206||m.id===3260||m.id===PUSH.DEAL));
  assert.ok(!f.table.hand.players.some(p=>p.uid===77),'new chair joins only a subsequent hand');
});
test('native add-time is bounded per player and cannot postpone other players or revive expired actions', () => {
  const f=fixture(),deadline=f.table.hand.deadline;
  assert.equal(engine.addTime(f.io,f.table,99,2000),false);
  assert.equal(engine.addTime(f.io,f.table,1,2000),true);
  assert.equal(f.table.hand.players[0].deadline,deadline+30000);
  assert.equal(f.table.hand.players[1].deadline,deadline);
  assert.equal(f.messages.findLast(m=>m.id===PUSH.TIME).data.arrangedCount,1);
  assert.equal(engine.addTime(f.io,f.table,1,3000),true);
  assert.equal(engine.addTime(f.io,f.table,1,4000),false);
  assert.equal(engine.addTime(f.io,f.table,2,deadline),false);
  engine.tick(f.io,f.table,deadline);
  assert.equal(f.table.hand.players[0].result,null);
  assert.ok(f.table.hand.players.slice(1).every(p=>p.result));
  engine.tick(f.io,f.table,deadline+60000);
  assert.ok(f.table.hand.settled);
});
