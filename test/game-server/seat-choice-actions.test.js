import test from 'node:test';
import assert from 'node:assert/strict';
import {seatChoiceActions,seatChoiceRecordActions} from '../../shared/native-player-actions.js';
import {playerPanelPersistedRecords,playerPanelStatistics} from '../../shared/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {importHotModule} from '../../shared/hot-import.js';

function source(type,facts,more={}){return {id:'seat',agentId:7,userId:42,currency:'CNY',roomType:type,roomId:700001,inning:1,endedAt:Date.now(),net:20,effectiveBet:20,
  detail:{nativeHistory:{row:{gameRoomId:700001,currentInningNum:1},seatChoiceBehavior:{version:1,playerId:42,...facts}}},...more};}
const player={uid:42,grab:1,manualGrab:true,bet:10,manualBet:true,aboveMinimumBet:true};
const hand={behaviorVersion:1,settled:true,bankerUid:43,players:[player]};

test('seat choices distinguish accepted manual decisions and banker betting eligibility',()=>{
  const facts=seatChoiceActions(24,hand,42);assert.deepEqual(facts,{known:true,betOpportunity:true,manualBet:true,aboveMinimumBet:true,manualGrab:true,positiveGrab:true});
  assert.deepEqual(seatChoiceActions(24,{...hand,bankerUid:42,players:[{...player,bet:null}]},42),{known:true,betOpportunity:false,manualBet:false,aboveMinimumBet:false,manualGrab:true,positiveGrab:true});
  assert.deepEqual(seatChoiceActions(32,{...hand,players:[{...player,manualBet:false,aboveMinimumBet:false}]},42),{known:true,betOpportunity:true,manualBet:false,aboveMinimumBet:false,manualGrab:false,positiveGrab:false});
});

test('legacy hands and invalid or foreign facts stay unknown rather than using payout amounts',()=>{
  for(const value of [{...hand,behaviorVersion:undefined},{...hand,settled:false},{...hand,players:[]},{...hand,players:[{...player,manualGrab:undefined}]},{...hand,players:[{...player,bet:0}]},{...hand,players:[{...player,manualBet:false}]}])assert.equal(seatChoiceActions(24,value,42).known,false);
  const facts=seatChoiceActions(24,hand,42);
  for(const change of [{inning:2},{roomId:99},{roomType:31}])assert.equal(seatChoiceRecordActions(source(24,facts,change),42).known,false);
  assert.equal(seatChoiceRecordActions(source(24,{...facts,betOpportunity:false}),42).known,false);
  assert.equal(seatChoiceRecordActions(source(32,facts),42).known,false);
});

test('seat statistical DTO keeps only facts, excludes banker hands from bet percentages and leaves poker rates unavailable',()=>{
  const facts=seatChoiceActions(24,hand,42),banker=seatChoiceActions(24,{...hand,bankerUid:42,players:[{...player,bet:null}]},42);
  const records=[source(24,facts),source(24,banker,{id:'banker'})];
  const dto=playerPanelPersistedRecords(records);assert.equal(dto[0].behaviorVersion,3);assert.deepEqual(dto[0].seatChoices,{betOpportunity:true,manualBet:true,aboveMinimumBet:true,manualGrab:true,positiveGrab:true});
  assert.deepEqual(dto[0].players,[]);assert.equal(dto[0].events,undefined);assert.equal(dto[0].detail,undefined);assert.equal(dto[1].voluntary,false);assert.equal(dto[1].raised,false);
  const stats=playerPanelStatistics(records,{targetId:42,roomId:700001,roomType:24});
  assert.equal(stats.betOpportunityHands,1);assert.equal(stats.manualBetPercent,100);assert.equal(stats.aboveMinimumBetPercent,100);assert.equal(stats.manualGrabPercent,100);
  assert.equal(stats.joinPercent,'--');assert.equal(stats.flipManualBetPercent,'--');assert.equal(stats.userFillingRate.flip3BetRate,'--');
  assert.equal(playerPanelStatistics([records[0],{...records[1],detail:{}}],{targetId:42,roomType:24}).manualBetHands,undefined);
});

test('production seat profiles validate denominator and game-specific grab counters',async()=>{
  for(const type of [24,32]){
    const gameId=type===24?'niuniu':'sgay',registry=createRegistry(),table={roomId:700001,agentId:7,roomType:type,gameId,members:[{uid:42,name:'real',point:10000}],observers:[]};registry.setTable(table.roomId,table,7,gameId);
    const session={userId:42,agentId:7,currency:'CNY',roomId:table.roomId,gameId,authenticated:true,inRoom:true};
    let stats={totalHands:4,behaviorHands:4,voluntaryHands:2,raisedHands:0,tableHands:4,tableBehaviorHands:4,tableVoluntaryHands:2,betOpportunityHands:type===24?3:4,aboveMinimumBetHands:1,manualGrabHands:type===24?2:0,positiveGrabHands:type===24?1:0};
    const panel=await createPlayerPanel({env:'prod',registry,gateway:{playerPanel:async action=>action==='noteGet'?{}:{records:[],complete:false,statistics:stats},getUserCenter:async()=>({paged:true,total:4,totalScore:10,records:[]})}});
    const result=await panel.profile(session,table,42);assert.equal(result.manualBetPercent,type===24?66.67:50);assert.equal(result.joinPercent,'--');assert.equal(result.flipManualBetPercent,'--');
    stats={...stats,betOpportunityHands:1};await assert.rejects(panel.profile(session,table,42),{status:503});
  }
});

for(const [type,gameId]of [[24,'niuniu'],[32,'sgay']])test(gameId+' real manual and automatic rounds preserve exact decision sources and actual settled facts',async()=>{
  const {default:game}=await importHotModule(new URL('../../game-server/src/games/'+gameId+'/index.js',import.meta.url).href,'seat-choice-report');
  const engine=await importHotModule(new URL('../../game-server/src/games/'+gameId+'/engine.js',import.meta.url).href,'seat-choice-report');
  for(const manual of [true,false]){
    const table=game.createTable(700001,type,{game_room_config_id:type===24?2401:3201,ante:10,carry_min:1000,play_mode:type===24?3:0,tax_percent:0}),registry=createRegistry();table.agentId=7;
    table.members=[{uid:42,pos:0,name:'one',point:10000,state:2,bot:false},{uid:43,pos:1,name:'two',point:10000,state:2,bot:false}];
    const runtime={env:'dev',registry,log:{error(){}}};installUserCenter(runtime);registry.setTable(table.roomId,table,7,gameId);
    const io={env:'dev',broadcast(){},send(){},sendUser(){},forEachPlayer(){}};
    engine.begin(io,table,1000,Array.from({length:52},(_,i)=>i));
    for(let step=0;step<20&&table.hand;step++){
      const h=table.hand;
      if(manual&&h.stage==='grab')for(const p of h.players)if(p.grab===null)assert.equal(engine.grab(io,table,p.uid,p.uid===42?1:0,h.deadline-1),true);
      if(manual&&h.stage==='bet')for(const p of h.players)if(p.bet===null&&p.uid!==h.bankerUid){
        const multiple=type===24?engine.betOptions(table,p)[1]:2;assert.equal(engine.bet(io,table,p.uid,multiple,h.deadline-1),true);
      }
      engine.tick(io,table,h.deadline);
    }
    assert.equal(table.hand,null);const records=[...runtime.userCenterState.records.values()],facts=playerPanelPersistedRecords(records);
    assert.equal(facts.length,2);assert.ok(facts.every(row=>row.countersKnown&&row.behaviorVersion===3));
    for(const row of facts){assert.equal(row.raised,false);assert.equal(row.seatChoices.manualBet,manual&&row.seatChoices.betOpportunity);assert.equal(row.seatChoices.aboveMinimumBet,manual&&row.seatChoices.betOpportunity);if(type===24)assert.equal(row.seatChoices.manualGrab,manual);}
    if(type===24){assert.equal(facts.filter(row=>row.seatChoices.betOpportunity).length,1);assert.equal(table.members.reduce((total,p)=>total+p.point,0),20000);}
  }
});
