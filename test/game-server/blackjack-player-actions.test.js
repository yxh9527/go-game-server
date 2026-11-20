import test from 'node:test';
import assert from 'node:assert/strict';
import {blackjackPlayerActions,blackjackRecordActions} from '../../shared/native-player-actions.js';
import {playerPanelPersistedRecords,playerPanelStatistics} from '../../shared/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {importHotModule} from '../../shared/hot-import.js';

const action=(type,amount=0,state=6,uid=42)=>({uid,banker:uid===0,actionType:type,amount,gameState:state});
const sequence=rows=>rows.map((row,index)=>({...row,round:index+1}));
function complete(betType=1,extra=[]){return sequence([action(betType,100,2),action(3,0,3),...extra,action(6,0,8)]);}
function record(facts,more={}){return {id:'bj',agentId:7,userId:42,currency:'CNY',roomType:31,roomId:31010000,inning:1,endedAt:Date.now(),net:20,effectiveBet:200,
  detail:{nativeHistory:{row:{gameRoomId:31010000,currentInningNum:1},blackjackBehavior:{version:1,playerId:42,...facts}}},...more};}

test('blackjack distinguishes timeout bets and independent double, split and insurance behavior',()=>{
  const manual=blackjackPlayerActions(complete(1,[action(12,100),action(13,100)]),42);
  assert.deepEqual(manual,{known:true,manualBet:true,doubled:true,split:true,insuranceBuy:false});
  const automatic=blackjackPlayerActions(complete(2,[action(10,0,4),action(7)]),42);
  assert.deepEqual(automatic,{known:true,manualBet:false,doubled:false,split:false,insuranceBuy:false});
  assert.equal(blackjackPlayerActions(complete(1,[action(8,50,4)]),42).insuranceBuy,true);
  assert.equal(blackjackPlayerActions(complete(1,[action(9,0,4)]),42).insuranceBuy,false);
});

test('incomplete, malformed and foreign action sequences remain unknown',()=>{
  for(const rows of [[],complete().slice(1),complete().slice(0,-1),sequence([action(1,100,2),action(6,0,8)]),
    complete(1,[action(12,0)]),complete(1,[action(8,50,6)]),complete(1,[action(3,0,3)]),complete(1,[action(1,100,2)]),
    complete().map((row,index)=>index===1?{...row,round:7}:row),complete().map((row,index)=>index===1?{...row,banker:true}:row),
  ])assert.equal(blackjackPlayerActions(rows,42).known,false);
  assert.equal(blackjackPlayerActions(complete(),43).known,false);
  const facts=blackjackPlayerActions(complete(),42);
  for(const more of [{inning:2},{roomId:99},{roomType:25}])assert.equal(blackjackRecordActions(record(facts,more),42).known,false);
  assert.equal(blackjackRecordActions(record({...facts,manualBet:'true'}),42).known,false);
});

test('blackjack DTO and rates preserve facts without copying cards or treating doubles as poker raises',()=>{
  const first=record(blackjackPlayerActions(complete(1,[action(12,100),action(13,100)]),42));
  const second=record(blackjackPlayerActions(complete(2,[action(7)]),42),{id:'bj2'});
  const [dto]=playerPanelPersistedRecords([first]);
  assert.equal(dto.behaviorVersion,2);assert.equal(dto.countersKnown,true);assert.equal(dto.voluntary,true);assert.equal(dto.raised,false);
  assert.deepEqual(dto.blackjackActions,{manualBet:true,doubled:true,split:true,insuranceBuy:false});assert.deepEqual(dto.players,[]);assert.equal(dto.events,undefined);assert.equal(dto.detail,undefined);
  const stats=playerPanelStatistics([first,second],{targetId:42,roomId:31010000,roomType:31});
  assert.equal(stats.joinPercent,50);assert.equal(stats.flipManualBetPercent,'--');assert.equal(stats.manualBetHands,1);assert.equal(stats.doublePercent,50);assert.equal(stats.splitPercent,50);assert.equal(stats.insuranceBuyHands,0);
  const incomplete=playerPanelStatistics([first,{...second,detail:{}}],{targetId:42,roomId:31010000,roomType:31});
  assert.equal(incomplete.joinPercent,'--');assert.equal(incomplete.doubleHands,undefined);
});

test('production blackjack profile validates aggregate counters without inferring a poker raise',async()=>{
  const registry=createRegistry(),table={agentId:7,roomId:31010000,roomType:31,gameId:'blackjack',members:[{uid:42,name:'real',point:1000}],observers:[]};registry.setTable(table.roomId,table,7,'blackjack');
  const session={userId:42,agentId:7,currency:'CNY',roomId:table.roomId,gameId:'blackjack',authenticated:true,inRoom:true};
  let stats={totalHands:4,behaviorHands:4,voluntaryHands:2,raisedHands:0,tableHands:2,tableBehaviorHands:2,tableVoluntaryHands:1,doubleHands:1,splitHands:2,insuranceBuyHands:0};
  const runtime={env:'prod',registry,gateway:{playerPanel:async action=>action==='noteGet'?{}:{records:[],complete:false,statistics:stats},getUserCenter:async()=>({paged:true,total:4,totalScore:20,records:[]})}};
  const panel=await createPlayerPanel(runtime),profile=await panel.profile(session,table,42);
  assert.equal(profile.joinPercent,50);assert.equal(profile.flipManualBetPercent,'--');assert.equal(profile.doublePercent,25);assert.equal(profile.splitPercent,50);
  stats={...stats,behaviorHands:3};assert.equal((await panel.profile(session,table,42)).doubleHands,undefined);
  stats={...stats,doubleHands:4};await assert.rejects(panel.profile(session,table,42),{status:503});
});

test('real manually accepted and timeout blackjack bets produce different settled behavior facts',async()=>{
  const {default:game}=await importHotModule(new URL('../../game-server/src/games/blackjack/index.js',import.meta.url).href,'blackjack-behavior');
  const engine=await importHotModule(new URL('../../game-server/src/games/blackjack/engine.js',import.meta.url).href,'blackjack-behavior');
  for(const manual of [true,false]){
    const table=game.createTable(31010000,31,{game_room_config_id:3101,ante:100,carry_min:500}),registry=createRegistry();table.agentId=7;
    table.members=[{uid:42,pos:0,name:'real',point:5000,bot:false,state:2}];
    const runtime={env:'dev',registry,log:{error(){}}};installUserCenter(runtime);registry.setTable(table.roomId,table,7,'blackjack');
    const io={env:'dev',broadcast(){},send(){},sendUser(){},forEachPlayer(){}};
    engine.begin(io,table,1000,[9,6,7,20,2,3,9,9]);
    if(manual)assert.equal(engine.act(io,table,42,4501,{betAmount:100},1001),true);
    let doubled=false;
    for(let index=0;index<30&&!table.hand?.settled;index++){
      if(manual&&!doubled&&table.hand.state===6){assert.equal(engine.act(io,table,42,4507,{},table.hand.deadline-1),true);doubled=true;}
      else engine.tick(io,table,table.hand.deadline+1);
    }
    assert.equal(table.hand.settled,true);const original=[...runtime.userCenterState.records.values()].find(row=>row.userId===42);
    const [dto]=playerPanelPersistedRecords([original]);assert.equal(dto.behaviorVersion,2);assert.equal(dto.voluntary,manual);assert.equal(dto.raised,false);assert.equal(dto.blackjackActions.doubled,manual);assert.equal(doubled,manual);
    const native=original.detail.nativeHistory;assert.equal(native.blackjackBehavior.manualBet,manual);assert.equal(native.blackjackBehavior.known,true);
    assert.equal(native.blackjackBehavior.wallet,undefined);assert.equal(native.blackjackBehavior.hands,undefined);
  }
});
