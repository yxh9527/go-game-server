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

test('production tournament continues after its replay write attempt fails and does not resubmit it',async()=>{
  const f=await fixture();f.finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.writes.length,1);assert.equal((await f.call('status')).data.reportingPending,true);
  f.writes[0].resolve({durable:false,stored:0});await f.runtime.userCenterState.writeTask;
  assert.equal(f.errors.length,1);assert.equal(f.runtime.userCenterState.outgoing.size,0);
  await f.reload();await f.center().flush();assert.equal(f.writes.length,1,'failed replay must not be retried');
  const status=await f.call('status');assert.equal(status.data.ready,true);assert.equal(status.data.reportingPending,false);
  const advanced=await f.call('advance',{revision:0});assert.equal(advanced.code,200);assert.equal(advanced.data.finished,true);
  assert.equal((await f.call('awards',{results:[{uid:42,rank:1,award:0,ticketNum:0},{uid:43,rank:2,award:0,ticketNum:0}]})).code,200);
  assert.equal((await f.call('cleanup')).data.released,true);
});

test('deferred record delivery cannot create a window with an apparently ready tournament',async()=>{
  const f=await fixture(),deliveries=[];f.runtime.wallet={deliver:send=>deliveries.push(send)};
  f.finish();assert.equal(f.runtime.userCenterState.outgoing.size,0);assert.equal(deliveries.length,1);
  assert.equal((await f.call('status')).data.ready,false);
  await f.reload();assert.equal((await f.call('status')).data.ready,false,'hot reload preserves a deferred delivery');
  deliveries[0]();await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.call('status')).data.ready,false);
  f.writes[0].resolve({durable:true,stored:2});await f.runtime.userCenterState.writeTask;
  assert.equal((await f.call('status')).data.ready,true);
});

test('missing or malformed participant replays block progression and invalidation still releases tables',async()=>{
  const f=await fixture();f.finish();
  await new Promise(resolve=>setImmediate(resolve));
  f.writes[0].resolve({durable:true,stored:2});await f.runtime.userCenterState.writeTask;
  // The second hand deliberately omits one real participant's final result.
  f.table.currentInning=2;f.table.hand={participants:f.table.members,board:[]};
  f.table.recordUserCenter([f.results[0]]);f.table.hand=null;f.table.mtt.checkedInning=2;
  assert.ok(f.errors.some(args=>String(args[0]).includes('projection failed')));
  assert.equal((await f.call('advance',{revision:0})).code,409);
  assert.equal((await f.call('status')).data.reportingPending,true);
  assert.equal((await f.call('invalidate')).data.released,true,'record failure must not prevent the original void/refund path');
});

test('first hot load adopts old pending replays and observes an old writer acknowledgement without nesting hooks',async()=>{
  const f=await fixture();f.finish();await new Promise(resolve=>setImmediate(resolve));
  // Simulate adoption before this protection existed on the resident table.
  delete f.table[Symbol.for('gogame.tournament.completedReports')];
  await f.reload();assert.equal((await f.call('status')).data.ready,false);
  f.writes[0].resolve({durable:true,stored:2});await f.runtime.userCenterState.writeTask;
  assert.equal((await f.call('status')).data.ready,true);
  assert.equal(f.writes.length,1);assert.equal(f.runtime.registry.tables.size,1);
});

test('older room incarnations and other matches do not block a new table sharing its room number',async()=>{
  const f=await fixture(),state=f.runtime.userCenterState;
  state.outgoing.set('previous-table',{id:'previous-table',replayOnly:true,agentId:7,roomId:f.table.roomId,gameId:'holdem',room:{createdAt:f.table.userCenterCreatedAt-1}});
  state.outgoing.set('other-match',{id:'other-match',replayOnly:true,agentId:8,roomId:f.table.roomId,gameId:'holdem'});
  await f.reload();assert.equal(f.table.userCenterReportsReady(),true);
  assert.equal(state.outgoing.size,2,'unrelated original records remain queued for their own retry');
});

test('already awarded resident tables cannot be reclaimed while their original completed replays still await storage',async()=>{
  const f=await fixture();f.finish();await new Promise(resolve=>setImmediate(resolve));
  // Adopt a terminal resident match that finished under the older module.
  const match=f.runtime.tournamentRooms.matches.get('7:99');match.finished=true;match.awardsAcknowledged=true;
  assert.equal((await f.call('cleanup')).data.released,false);
  assert.equal(f.runtime.registry.tables.size,1);
  f.writes[0].resolve({durable:true,stored:2});await f.runtime.userCenterState.writeTask;
  assert.equal((await f.call('cleanup')).data.released,true);
  assert.equal(f.runtime.registry.tables.size,0);
});

test('an ended inning with no captured participant reports cannot be declared ready',async()=>{
  const f=await fixture();
  f.table.currentInning=1;f.table.mtt.checkedInning=1;f.table.mtt.paused=true;
  f.table.phase='idle';f.table.startAt=0;f.table.roomFeatures={settledInning:1};
  assert.equal(f.runtime.userCenterState.outgoing.size,0);
  const response=await f.call('status');assert.equal(response.data.ready,false);assert.equal(response.data.reportingPending,true);
  assert.equal((await f.call('advance',{revision:0})).code,409);
  f.table.hand={participants:[]};f.table.recordUserCenter([]);f.table.hand=null;
  assert.equal((await f.call('status')).data.ready,false,'an empty projection is not a confirmed completed hand');
});
