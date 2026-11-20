import test from 'node:test';
import assert from 'node:assert/strict';
import {mahjongDiscardActions,mahjongRecordActions} from '../../shared/native-player-actions.js';
import {playerPanelPersistedRecords,playerPanelStatistics} from '../../shared/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {importHotModule} from '../../shared/hot-import.js';

function source(type,facts,more={}){return {id:'mahjong',agentId:7,userId:42,currency:'CNY',roomType:type,roomId:700001,inning:1,endedAt:Date.now(),net:20,effectiveBet:20,
  detail:{nativeHistory:{row:{gameRoomId:700001,currentInningNum:1},mahjongBehavior:{version:1,playerId:42,...facts}}},...more};}
const player={uid:42,clientDiscard:true,serverDiscard:true,discardCount:2},hand={behaviorVersion:1,settled:true,players:[player]};

test('Mahjong sources permit mixed discards and real zero-discard hands but reject incomplete evidence',()=>{
  assert.deepEqual(mahjongDiscardActions(hand,42),{known:true,clientDiscard:true,serverDiscard:true});
  assert.deepEqual(mahjongDiscardActions({...hand,players:[{...player,clientDiscard:false,serverDiscard:false,discardCount:0}]},42),{known:true,clientDiscard:false,serverDiscard:false});
  for(const value of [{...hand,behaviorVersion:undefined},{...hand,settled:false},{...hand,players:[]},...[
    {clientDiscard:undefined},{serverDiscard:1},{discardCount:-1},{discardCount:0},{discardCount:1},{discardCount:2.5},{clientDiscard:false,serverDiscard:false}
  ].map(change=>({...hand,players:[{...player,...change}]}))])assert.equal(mahjongDiscardActions(value,42).known,false);
});

test('Mahjong record evidence matches all three exact game types and excludes foreign identities or rounds',()=>{
  const facts={known:true,clientDiscard:true,serverDiscard:false};
  for(const type of [26,28,30]){
    assert.equal(mahjongRecordActions(source(type,facts),42).known,true);
    for(const change of [{inning:2},{roomId:99},{roomType:27}])assert.equal(mahjongRecordActions(source(type,facts,change),42).known,false);
    for(const change of [{known:false},{clientDiscard:'true'},{serverDiscard:1},{playerId:43},{version:2}])assert.equal(mahjongRecordActions(source(type,{...facts,...change}),42).known,false);
  }
});

test('Mahjong statistical projections count overlapping source hands without saving private history or guessing poker rates',()=>{
  for(const type of [26,28,30]){
    const records=[source(type,{known:true,clientDiscard:true,serverDiscard:true}),source(type,{known:true,clientDiscard:false,serverDiscard:true},{id:'auto'})];
    const dto=playerPanelPersistedRecords(records);
    assert.equal(dto[0].behaviorVersion,5);assert.deepEqual(dto[0].mahjongDiscards,{clientDiscard:true,serverDiscard:true});
    assert.equal(dto[0].countersKnown,true);assert.equal(dto[0].voluntary,false);assert.equal(dto[0].raised,false);
    assert.deepEqual(dto[0].players,[]);assert.equal(dto[0].detail,undefined);assert.equal(dto[0].events,undefined);
    const stats=playerPanelStatistics(records,{targetId:42,roomId:700001,roomType:type});
    assert.equal(stats.clientDiscardHands,1);assert.equal(stats.clientDiscardPercent,50);assert.equal(stats.serverDiscardPercent,100);
    assert.equal(stats.joinPercent,'--');assert.equal(stats.flipManualBetPercent,'--');assert.equal(stats.userFillingRate.flip3BetRate,'--');
    assert.equal(playerPanelStatistics([records[0],{...records[1],detail:{}}],{targetId:42,roomType:type}).clientDiscardHands,undefined);
    assert.equal(playerPanelStatistics(records,{targetId:42,roomType:type,complete:false}).clientDiscardHands,undefined);
  }
});

test('production Mahjong profiles validate sources independently and do not invent counts for old evidence',async()=>{
  for(const type of [26,28,30]){
    const registry=createRegistry(),table={roomId:700001,agentId:7,roomType:type,gameId:'mahjong',members:[{uid:42,name:'real',point:10000}],observers:[]};registry.setTable(table.roomId,table,7,'mahjong');
    const session={userId:42,agentId:7,currency:'CNY',roomId:table.roomId,gameId:'mahjong',authenticated:true,inRoom:true};
    const valid={totalHands:4,behaviorHands:4,voluntaryHands:0,raisedHands:0,tableHands:4,tableBehaviorHands:4,tableVoluntaryHands:0,clientDiscardHands:3,serverDiscardHands:4};let stats=valid;
    const panel=await createPlayerPanel({env:'prod',registry,gateway:{playerPanel:async action=>action==='noteGet'?{}:{records:[],complete:false,statistics:stats},getUserCenter:async()=>({paged:true,total:4,totalScore:10,records:[]})}});
    const result=await panel.profile(session,table,42);assert.equal(result.clientDiscardPercent,75);assert.equal(result.serverDiscardPercent,100);assert.equal(result.joinPercent,'--');assert.equal(result.flipManualBetPercent,'--');
    for(const change of [{clientDiscardHands:5},{serverDiscardHands:-1},{clientDiscardHands:1.2},{serverDiscardHands:undefined},{voluntaryHands:1}]){stats={...valid,...change};await assert.rejects(panel.profile(session,table,42),{status:503});}
    stats={...valid,behaviorHands:3,tableBehaviorHands:3,serverDiscardHands:3};assert.equal((await panel.profile(session,table,42)).clientDiscardHands,undefined);
  }
});

for(const [type,mode]of [[26,1],[26,0],[28,2],[28,4],[30,1],[30,0]])test('Mahjong '+type+'/'+mode+' actual client discard and server timeout survive complete settlement',async()=>{
  const version='mahjong-discard-report';
  const {default:game}=await importHotModule(new URL('../../game-server/src/games/mahjong/index.js',import.meta.url).href,version);
  const engine=await importHotModule(new URL('../../game-server/src/games/mahjong/engine.js',import.meta.url).href,version);
  const tiles=await importHotModule(new URL('../../game-server/src/games/mahjong/tiles.js',import.meta.url).href,version);
  const {OP}=await importHotModule(new URL('../../game-server/src/games/mahjong/messages.js',import.meta.url).href,version);
  const table=game.createTable(700001,type,{room_type:type,play_mode:mode,ante:10,carry_min:2000,tax_percent:0}),registry=createRegistry();table.agentId=7;
  table.members=Array.from({length:table.roomRules.maxPeople},(_,pos)=>({uid:42+pos,pos,name:'real-'+pos,point:100000,state:2,bot:false}));
  const runtime={env:'dev',registry,log:{error(){}}};installUserCenter(runtime);registry.setTable(table.roomId,table,7,'mahjong');
  const io={env:'dev',broadcast(){},send(){},sendUser(){},forEachPlayer(){}};
  assert.equal(engine.begin(io,table,1000,tiles.deckFor(table.roomRules)),true);
  for(let step=0;step<15&&table.hand?.stage!=='turn';step++)engine.tick(io,table,table.hand.deadline);
  assert.equal(table.hand.stage,'turn');const h=table.hand,p=h.players.find(p=>p.uid===h.actorUid),at=h.time+1;
  assert.equal(engine.action(io,table,p.uid,{type:OP.DISCARD,card:-1,isAuto:true},at),false);assert.equal(p.clientDiscard,false);assert.equal(p.serverDiscard,false);
  const accepted=p.handCards.slice().some(card=>engine.action(io,table,p.uid,{type:OP.DISCARD,card,isAuto:true},at));
  assert.equal(accepted,true);assert.equal(p.clientDiscard,true);assert.equal(p.serverDiscard,false);
  for(let step=0;step<1500&&table.hand;step++)engine.tick(io,table,table.hand.deadline);
  assert.equal(table.hand,null);assert.equal(h.settled,true);assert.ok(h.players.some(p=>p.serverDiscard));
  const records=playerPanelPersistedRecords([...runtime.userCenterState.records.values()]);assert.equal(records.length,table.members.length);
  for(const row of records){const original=h.players.find(p=>p.uid===row.userId);assert.equal(row.behaviorVersion,5);assert.equal(row.countersKnown,true);assert.deepEqual(row.mahjongDiscards,{clientDiscard:original.clientDiscard,serverDiscard:original.serverDiscard});assert.equal(row.raised,false);assert.equal(row.voluntary,false);}
  assert.equal(table.members.reduce((sum,p)=>sum+p.point,0),table.members.length*100000);
});
