import test from 'node:test';
import assert from 'node:assert/strict';
import {zjhPlayerActions,zjhRecordActions} from '../../shared/native-player-actions.js';
import {playerPanelPersistedRecords,playerPanelStatistics} from '../../shared/player-panel.js';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {importHotModule} from '../../shared/hot-import.js';
import {seedRooms} from '../../cache/rpc/seed.js';

const action=(operationType,bet,uid=42)=>({uid,operationType,bet,gameState:operationType===1?1:4});
function record(events,more={}){return {id:'hand',agentId:7,userId:42,currency:'CNY',roomId:700001,roomType:25,inning:1,endedAt:Date.now(),net:10,effectiveBet:10,
  detail:{nativeHistory:{events,row:{gameRoomId:700001,currentInningNum:1}}},...more};}

test('ZJH distinguishes paid actions from antes, looking, folding and explicit raises',()=>{
  for(const op of [3,4,6,8]){
    assert.deepEqual(zjhPlayerActions([action(1,10),action(op,20)],42),{known:true,voluntary:true,raised:op===4});
  }
  for(const op of [2,7,9])assert.deepEqual(zjhPlayerActions([action(1,10),action(op,0)],42),{known:true,voluntary:false,raised:false});
  assert.deepEqual(zjhPlayerActions([action(1,10),action(1,10,43),action(4,20,43),action(2,0)],42),{known:true,voluntary:false,raised:false});
});

test('unknown, truncated or malformed action evidence remains unavailable rather than guessed from winnings',()=>{
  for(const events of [undefined,[],[action(3,20)],[action(1,10),action(1,10)],
    [action(1,10),action(99,0)],[action(1,10),action(4,0)],[action(1,10),action(3,-1)],
    [action(1,10),{...action(3,20),gameState:1}],[action(1,10),action(7,10)],
    [action(1,10),{...action(3,20),bet:'20'}],[action(1,10),action(3,20,0)]]){
    assert.equal(zjhPlayerActions(events,42).known,false);
  }
  assert.equal(zjhRecordActions(record([action(1,10)] ,{inning:2}),42).known,false);
  assert.equal(zjhRecordActions(record([action(1,10)] ,{roomType:32}),42).known,false);
  assert.equal(zjhRecordActions(record([action(1,10)] ,{roomId:99}),42).known,false);
});

test('statistical DTO preserves only versioned behavior flags and never copies cards, actions or wallets to MySQL',()=>{
  const source=record([action(1,10),{...action(4,20),cards:[1,2,3],wallet:999}]);
  const [dto]=playerPanelPersistedRecords([source]);
  assert.equal(dto.behaviorVersion,1);assert.equal(dto.countersKnown,true);assert.equal(dto.raised,true);assert.equal(dto.voluntary,true);assert.deepEqual(dto.players,[]);
  assert.equal(dto.events,undefined);assert.equal(dto.detail,undefined);assert.ok(!JSON.stringify(dto).includes('wallet'));
  const [old]=playerPanelPersistedRecords([{...source,detail:{firstGameList:[{uid:42,operateList:[action(4,20)]}]}}]);
  assert.equal(old.countersKnown,false);assert.equal(old.behaviorVersion,undefined);
  assert.deepEqual(playerPanelPersistedRecords([{...source,userId:90000001}]),[]);
});

test('ZJH rates use confirmed action hands and the exact room, and never reuse Holdem 3-bet rules',()=>{
  const one=record([action(1,10),action(3,20)]),two=record([action(1,10),action(4,20)],{id:'second',inning:2,roomId:700002,detail:{nativeHistory:{events:[action(1,10),action(4,20)],row:{gameRoomId:700002,currentInningNum:2}}}});
  const stats=playerPanelStatistics([one,two],{targetId:42,roomId:700001,roomType:25});
  assert.equal(stats.joinPercent,100);assert.equal(stats.flipManualBetPercent,50);assert.equal(stats.tableJoinPercent,100);
  assert.equal(stats.userFillingRate.flip3BetRate,'--');
  const incomplete=playerPanelStatistics([one,{...two,detail:{}}],{targetId:42,roomId:700001,roomType:25});
  assert.equal(incomplete.joinPercent,'--');assert.equal(incomplete.tableJoinPercent,100);
});

test('production profile validates data-center action counters and leaves old evidence incomplete',async()=>{
  const registry=createRegistry(),member={uid:42,name:'real',point:100},table={roomId:700001,agentId:7,roomType:25,gameId:'zjh',members:[member],observers:[]};
  registry.setTable(table.roomId,table,7,'zjh');
  const session={userId:42,agentId:7,roomId:table.roomId,gameId:'zjh',currency:'CNY',authenticated:true,inRoom:true};
  let totals={totalHands:4,behaviorHands:4,voluntaryHands:2,raisedHands:1,tableHands:2,tableBehaviorHands:2,tableVoluntaryHands:1};
  const runtime={env:'prod',registry,gateway:{playerPanel:async action=>action==='noteGet'?{}:{records:[],complete:false,statistics:totals},getUserCenter:async()=>({paged:true,total:4,totalScore:0,records:[]})}};
  const panel=await createPlayerPanel(runtime),profile=await panel.profile(session,table,42);
  assert.equal(profile.joinPercent,50);assert.equal(profile.flipManualBetPercent,25);assert.equal(profile.tableJoinPercent,50);
  totals={...totals,behaviorHands:3};assert.equal((await panel.profile(session,table,42)).joinPercent,'--');
  totals={...totals,raisedHands:3};await assert.rejects(panel.profile(session,table,42),{status:503});
  totals={totalHands:4};assert.equal((await panel.profile(session,table,42)).joinPercent,'--');
});

test('an actual accepted ZJH call then fold produces behavior flags from the completed hand',async()=>{
  const {default:game}=await importHotModule(new URL('../../game-server/src/games/zjh/index.js',import.meta.url).href,'zjh-action-report');
  const engine=await importHotModule(new URL('../../game-server/src/games/zjh/engine.js',import.meta.url).href,'zjh-action-report');
  const row=seedRooms().find(row=>Number(row.room_type)===25),table=game.createTable(700001,25,row),registry=createRegistry();
  Object.assign(table,{agentId:7,ante:10,carryMin:10});
  table.members.push({uid:42,pos:0,name:'one',point:1000},{uid:43,pos:1,name:'two',point:1000});
  const runtime={env:'dev',registry,log:{error(){}}};installUserCenter(runtime);registry.setTable(table.roomId,table,7,'zjh');
  const io={env:'dev',broadcast(){},send(){},sendUser(){},forEachPlayer(){}};
  engine.beginHand(io,table);const actor=table.hand.actorUid;
  assert.equal(engine.onZjhAction(io,table,{userId:actor},{uid:actor,operation:3}),true);
  const next=table.hand.actorUid;assert.equal(engine.onZjhAction(io,table,{userId:next},{uid:next,operation:2}),true);
  assert.equal(table.hand,null);
  const records=[...runtime.userCenterState.records.values()],facts=playerPanelPersistedRecords(records);
  assert.equal(facts.length,2);assert.ok(facts.every(row=>row.countersKnown&&row.behaviorVersion===1));
  assert.equal(facts.find(row=>row.userId===actor).voluntary,true);assert.equal(facts.find(row=>row.userId===next).voluntary,false);
  assert.ok(facts.every(row=>!row.raised));assert.equal(table.members.reduce((total,member)=>total+member.point,0),2000);
});
