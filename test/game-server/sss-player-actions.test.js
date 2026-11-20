import test from 'node:test';
import assert from 'node:assert/strict';
import {arrangementChoiceActions,arrangementRecordActions} from '../../shared/native-player-actions.js';
import {playerPanelPersistedRecords,playerPanelStatistics} from '../../shared/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {importHotModule} from '../../shared/hot-import.js';

function source(facts,more={}){return {id:'sss',agentId:7,userId:42,currency:'CNY',roomType:27,roomId:700001,inning:1,endedAt:Date.now(),net:20,effectiveBet:20,
  detail:{nativeHistory:{row:{gameRoomId:700001,currentInningNum:1},arrangementBehavior:{version:1,playerId:42,...facts}}},...more};}
const player={uid:42,result:{},clientSubmittedArrangement:true,arrangementExtensions:1};
const hand={behaviorVersion:1,settled:true,players:[player]};

test('SSS facts distinguish client submission from server arrangement and record accepted extensions',()=>{
  assert.deepEqual(arrangementChoiceActions(hand,42),{known:true,clientSubmitted:true,extended:true});
  assert.deepEqual(arrangementChoiceActions({...hand,players:[{...player,clientSubmittedArrangement:false,arrangementExtensions:0}]},42),{known:true,clientSubmitted:false,extended:false});
  for(const value of [{...hand,behaviorVersion:undefined},{...hand,settled:false},{...hand,players:[]},...[
    {result:null},{clientSubmittedArrangement:undefined},{arrangementExtensions:undefined},{arrangementExtensions:-1},{arrangementExtensions:1.5}
  ].map(change=>({...hand,players:[{...player,...change}]}))])assert.equal(arrangementChoiceActions(value,42).known,false);
});

test('SSS record evidence must match exact game, round, room and player',()=>{
  const facts=arrangementChoiceActions(hand,42);
  assert.equal(arrangementRecordActions(source(facts),42).known,true);
  for(const change of [{inning:2},{roomId:99},{roomType:24}])assert.equal(arrangementRecordActions(source(facts,change),42).known,false);
  for(const change of [{known:false},{clientSubmitted:'true'},{extended:1},{playerId:43},{version:2}])assert.equal(arrangementRecordActions(source({...facts,...change}),42).known,false);
});

test('SSS projection contains statistical facts only and never translates arrangements into poker betting',()=>{
  const records=[source({known:true,clientSubmitted:true,extended:true}),source({known:true,clientSubmitted:false,extended:false},{id:'auto'})];
  const dto=playerPanelPersistedRecords(records);
  assert.equal(dto[0].behaviorVersion,4);assert.deepEqual(dto[0].arrangementChoices,{clientSubmitted:true,extended:true});
  assert.equal(dto[0].countersKnown,true);assert.equal(dto[0].voluntary,false);assert.equal(dto[0].raised,false);
  assert.deepEqual(dto[0].players,[]);assert.equal(dto[0].detail,undefined);assert.equal(dto[0].events,undefined);
  const stats=playerPanelStatistics(records,{targetId:42,roomId:700001,roomType:27});
  assert.equal(stats.clientArrangementPercent,50);assert.equal(stats.serverArrangementHands,1);assert.equal(stats.extendedArrangementPercent,50);
  assert.equal(stats.joinPercent,'--');assert.equal(stats.flipManualBetPercent,'--');assert.equal(stats.userFillingRate.flip3BetRate,'--');
  assert.equal(playerPanelStatistics([records[0],{...records[1],detail:{}}],{targetId:42,roomType:27}).clientArrangementHands,undefined);
  assert.equal(playerPanelStatistics(records,{targetId:42,roomType:27,complete:false}).clientArrangementHands,undefined);
});

test('production SSS profiles validate counts and preserve unknown legacy proportions',async()=>{
  const registry=createRegistry(),table={roomId:700001,agentId:7,roomType:27,gameId:'sss',members:[{uid:42,name:'real',point:10000}],observers:[]};registry.setTable(table.roomId,table,7,'sss');
  const session={userId:42,agentId:7,currency:'CNY',roomId:table.roomId,gameId:'sss',authenticated:true,inRoom:true};
  const valid={totalHands:4,behaviorHands:4,voluntaryHands:0,raisedHands:0,tableHands:4,tableBehaviorHands:4,tableVoluntaryHands:0,clientArrangementHands:3,extendedArrangementHands:1};let stats=valid;
  const panel=await createPlayerPanel({env:'prod',registry,gateway:{playerPanel:async action=>action==='noteGet'?{}:{records:[],complete:false,statistics:stats},getUserCenter:async()=>({paged:true,total:4,totalScore:10,records:[]})}});
  const result=await panel.profile(session,table,42);assert.equal(result.clientArrangementPercent,75);assert.equal(result.serverArrangementPercent,25);assert.equal(result.extendedArrangementPercent,25);
  assert.equal(result.joinPercent,'--');assert.equal(result.flipManualBetPercent,'--');
  for(const change of [{clientArrangementHands:5},{extendedArrangementHands:-1},{clientArrangementHands:1.2},{extendedArrangementHands:undefined},{voluntaryHands:1}]){stats={...valid,...change};await assert.rejects(panel.profile(session,table,42),{status:503});}
  stats={...valid,behaviorHands:3,tableBehaviorHands:3};assert.equal((await panel.profile(session,table,42)).clientArrangementHands,undefined);
});

test('SSS real client submission, rejected request and timeout produce exact facts without changing settlement',async()=>{
  const {default:game}=await importHotModule(new URL('../../game-server/src/games/sss/index.js',import.meta.url).href,'sss-arrangement-report');
  const engine=await importHotModule(new URL('../../game-server/src/games/sss/engine.js',import.meta.url).href,'sss-arrangement-report');
  const table=game.createTable(700001,27,{game_room_config_id:2701,ante:10,carry_min:1000,play_mode:0,arrange_extend_count:1}),registry=createRegistry();table.agentId=7;
  table.members=[{uid:42,pos:0,name:'one',point:10000,state:2,bot:false},{uid:43,pos:1,name:'two',point:10000,state:2,bot:false}];
  const runtime={env:'dev',registry,log:{error(){}}};installUserCenter(runtime);registry.setTable(table.roomId,table,7,'sss');
  const io={env:'dev',broadcast(){},send(){},sendUser(){},forEachPlayer(){}};
  engine.begin(io,table,1000,Array.from({length:54},(_,i)=>i));
  const p=table.hand.players[0],option=p.options[0];
  assert.equal(engine.arrange(io,table,42,{front:[],middle:[],back:[]}),false);assert.equal(p.clientSubmittedArrangement,undefined);
  assert.equal(engine.addTime(io,table,42,2000),true);assert.equal(engine.addTime(io,table,42,2001),false);assert.equal(p.arrangementExtensions,1);
  assert.equal(engine.arrange(io,table,42,{...option,automatic:true}),true);assert.equal(p.clientSubmittedArrangement,true);
  assert.equal(engine.addTime(io,table,42,2002),false);
  engine.tick(io,table,table.hand.deadline);
  assert.equal(table.hand.settled,true);assert.equal(table.hand.players[1].clientSubmittedArrangement,false);
  const facts=playerPanelPersistedRecords([...runtime.userCenterState.records.values()]);assert.equal(facts.length,2);
  assert.deepEqual(facts.find(row=>row.userId===42).arrangementChoices,{clientSubmitted:true,extended:true});
  assert.deepEqual(facts.find(row=>row.userId===43).arrangementChoices,{clientSubmitted:false,extended:false});
  assert.ok(facts.every(row=>row.countersKnown&&row.behaviorVersion===4&&!row.voluntary&&!row.raised));
  assert.equal(table.members.reduce((sum,p)=>sum+p.point,0),20000);
  engine.tick(io,table,table.hand.deadline);assert.equal(table.hand,null);
});
