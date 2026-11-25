import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRegistry} from '../../game-server/src/registry.js';
const {installUserCenter}=await importHotModule(new URL('../../game-server/src/core/user-center.js',import.meta.url).href,'player-service-regression');
const {createTournamentControl}=await importHotModule(new URL('../../game-server/src/core/tournament.js',import.meta.url).href,'tournament-regression');
const {signControl}=await importHotModule(new URL('../../shared/tournament-control.js',import.meta.url).href,'tournament-regression');

const secret='tournament-record-test';
async function fixture(){
  const writes=[],errors=[];
  const runtime={env:'prod',hotVersion:'tournament-records',registry:createRegistry(),config:{match_control_secret:secret,tournament_cleanup_delay_ms:0},
    rpc:{lobby:{getMatch:async id=>({id,agent_id:7,state:2})}},log:{error:(...args)=>errors.push(args)},
    gateway:{writeUserCenter:rows=>new Promise(resolve=>writes.push({rows,resolve}))}};
  let center=installUserCenter(runtime);
  const game={config:{maxPeople:9},queueStart:table=>{table.phase='starting';},
    createTable:(roomId,roomType,cfg)=>({roomId,roomType,cfg,gameId:'holdem',kind:'normal',phase:'idle',currentInning:0,startAt:0,members:[]})};
  const io=()=>({broadcast(){},send(){},sendUser(){},forEachPlayer(){}});
  let control=await createTournamentControl(runtime,()=>game,io);
  const call=async(action,more={},matchId=99)=>{
    let response;
    await control.handle({readyState:1,send:raw=>{response=JSON.parse(raw);}},signControl(secret,{agentId:7,matchId,action,...more}));
    return response;
  };
  const started=await call('start',{config:{initPoint:100,currency:'CNY',startedAt:Date.now(),levels:[{min:5,max:10,interval:0}]},
    players:[{uid:42,name:'one',point:100},{uid:43,name:'two',point:100}]});
  assert.equal(started.code,200);
  const table=runtime.registry.getTable(started.data.tables[0].room_id,7,'holdem');
  const results=[{uid:42,score:100,xiaZhuData:100,showCards:[]},{uid:43,score:-100,xiaZhuData:100,showCards:[]}];
  function finish(){
    table.currentInning=1;table.members[0].point=200;table.members[1].point=0;
    for(const m of table.members)m.hole=m.uid===42?[1,2]:[3,4];
    table.hand={participants:table.members,board:[],replayActions:[],replayEvents:[]};
    table.recordUserCenter(results);table.hand=null;table.phase='idle';table.startAt=0;table.mtt.paused=true;table.mtt.checkedInning=1;
  }
  return {runtime,table,writes,errors,results,call,finish,
    center:()=>center,
    reload:async()=>{center=installUserCenter(runtime);control=await createTournamentControl(runtime,()=>game,io);}};
}

test('production tournament advances, awards and cleans up without saving individual hands',async()=>{
 const f=await fixture();f.finish();await f.center().flush();assert.equal(f.writes.length,0);assert.equal(f.runtime.userCenterState.records.size,0);assert.equal(f.runtime.userCenterState.outgoing.size,0);
 const status=await f.call('status');assert.equal(status.data.reportingPending,false);assert.equal(status.data.ready,true);
 assert.equal((await f.call('advance',{revision:0})).data.finished,true);
 assert.equal((await f.call('awards',{results:[{uid:42,rank:1,award:0,ticketNum:0},{uid:43,rank:2,award:0,ticketNum:0}]})).code,200);assert.equal((await f.call('cleanup')).data.released,true);assert.equal(f.writes.length,0);
});

test('hot replacement drops unsent tournament hands and obsolete barriers while retaining cash records',async()=>{
 const f=await fixture(),state=f.runtime.userCenterState;
 state.outgoing.set('old-hand',{id:'old-hand',roomType:101,replayOnly:true});state.outgoing.set('cash',{id:'cash',roomType:19});state.records.set('old-hand',{id:'old-hand',roomType:101});
 f.table[Symbol.for('gogame.tournament.completedReports')]={pending:new Map([['old-hand',false]]),error:true};
 await f.reload();assert.equal(state.outgoing.has('old-hand'),false);assert.equal(state.records.has('old-hand'),false);assert.equal(state.outgoing.has('cash'),true);assert.equal(f.table.userCenterReportsReady(),true);
 f.finish();assert.equal((await f.call('status')).data.ready,true);assert.equal(f.writes.length,0);
});

test('a finished hand does not require participant replay capture before the next checkpoint',async()=>{
 const f=await fixture();f.table.currentInning=1;f.table.mtt.checkedInning=1;f.table.mtt.paused=true;f.table.phase='idle';f.table.startAt=0;f.table.roomFeatures={settledInning:1};
 assert.equal((await f.call('status')).data.reportingPending,false);assert.equal((await f.call('status')).data.ready,true);f.table.recordUserCenter([]);assert.equal(f.writes.length,0);
});
