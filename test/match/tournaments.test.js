import test from 'node:test';
import assert from 'node:assert/strict';
import { createTournaments } from '../../match/src/tournaments.js';
import { createMatchService } from '../../match/src/services/match.js';
import { createMemoryStore } from '../../cache/rpc/store.js';
import { dailyInstant, scheduleSlot } from '../../match/src/schedule.js';

const user = (id=10001,agentId=1) => ({userId:id,agentId,name:'player'+id});
async function fixture(options={}) {
  let time=Date.parse('2026-10-30T03:00:00Z'), failRefund=false;
  const balances=new Map(),charges=[],credits=[],events=[],errors=[];
  const runtime={env:'dev',hotVersion:'tests',config:{},clock:()=>time,store:createMemoryStore(),
    log:{error:(...e)=>errors.push(e)},bus:{publish:async(_channel,event)=>events.push(JSON.parse(event))},
    rpc:{common:{
      debit:async(id,n)=>{const b=balances.get(id)??1000;if(b<n)return {ok:false};balances.set(id,b-n);charges.push(n);return {ok:true};},
      credit:async(id,n)=>{if(failRefund)throw new Error('wallet timeout');balances.set(id,(balances.get(id)??1000)+n);credits.push(n);return {ok:true};},
    },gateway:{authenticate:async(_t,id)=>({success:true,userId:id}),getLoginData:async id=>({agentId:1,userName:'player'+id})}},...options};
  const matches=await createMatchService(runtime), t=await createTournaments(runtime,matches);
  async function create(patch={}) { return matches.create({agent_id:1,init_point:10000,min_player:2,max_player:9,
    state:1,start_time:time+60000,register_gold:100,service_gold:10,...patch}); }
  return {runtime,t,matches,create,balances,charges,credits,events,errors,
    advance:n=>{time+=n;},setTime:n=>{time=n;},refundFailure:v=>{failRefund=v;}};
}

test('daily slots follow the operating timezone; repeated DST clocks select the first instant',()=>{
  assert.equal(dailyInstant('2026-10-30','12:00','Asia/Shanghai'),Date.parse('2026-10-30T04:00:00Z'));
  assert.equal(dailyInstant('2026-11-01','01:30','America/New_York'),Date.parse('2026-11-01T05:30:00Z'));
  assert.throws(()=>dailyInstant('2026-03-08','02:30','America/New_York'),/does not exist/);
  assert.throws(()=>dailyInstant('2026-02-30','12:00','UTC'),/calendar/);
  assert.equal(scheduleSlot({id:8,schedule_kind:'once',start_time:123456}).key,'8:once');
});

test('admin pause rejects late signup, retries the same command, and archived matches keep registrations',async()=>{
  let paused=false,version=0,drop=true;
  const clock=()=>({currentBlindLv:1,nextBlindAt:0,pauseRequested:paused,pauseVersion:version,pauseAt:paused?1:null,registrationDelayMs:0});
  const adapter={start:async(_r,players)=>[{room_id:81000000,players:players.map(p=>p.userId)}],status:async()=>({ready:false,clock:clock()}),advance:async()=>{},
    pause:async(_row,command)=>{paused=command.paused;version=command.pauseVersion;if(drop){drop=false;throw Error('lost acknowledgment')}return {clock:clock()}}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({delay_register_time:300});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  const actor={agentId:1,kind:'platform'};
  await assert.rejects(()=>f.t.setPause(m.id,true,actor),/lost acknowledgment/);
  assert.equal((await f.t.inspect(m.id)).state.manualPause.version,1);
  await assert.rejects(()=>f.t.register(m.id,user(10003)),/暂停/);
  await f.t.setPause(m.id,true,actor);assert.equal((await f.t.inspect(m.id)).state.manualPause.ackVersion,1);
  await f.t.setPause(m.id,false,actor);assert.equal(version,2);
  await assert.rejects(()=>f.t.archive(m.id,actor),/先结束或取消/);
  await f.runtime.store.updateMatch(m.id,{state:4});await f.t.archive(m.id,actor);
  const view=(await f.t.listAdmin(1)).find(row=>row.id===m.id);assert.equal(view.admin.archived,true);
  assert.equal(Object.keys((await f.t.inspect(m.id)).state.registrations).length,2);
});

test('admin resume at an automatic pause uses the game clock version and retains it after a lost reply',async()=>{
 let command,drop=true;
 const f=await fixture({tournamentTables:{pause:async(_row,request)=>{command=request;if(drop){drop=false;throw Error('resume reply lost')}return {clock:{pauseVersion:request.pauseVersion,pauseRequested:false,currentBlindLv:3,registrationDelayMs:60000}}}}});
 const m=await f.create();await f.runtime.store.updateMatch(m.id,{state:2});
 const repo=f.runtime.tournamentMemory;
 repo.docs.set(m.id,{registrations:{},outbox:[],clock:{autoPauseIndex:1,pauseRequested:true,pauseAt:1,pauseVersion:5},manualPause:{paused:false,version:2,ackVersion:2}});
 const actor={agentId:1,kind:'platform'};
 await assert.rejects(()=>f.t.setPause(m.id,false,actor),/reply lost/);assert.equal(command.pauseVersion,6);
 await f.t.setPause(m.id,false,actor);assert.equal(command.pauseVersion,6,'resume retry uses the same version');
 const saved=await f.t.inspect(m.id);assert.equal(saved.state.manualPause.ackVersion,6);assert.equal(saved.state.clock.pauseRequested,false);
});
test('concurrent native registrations reserve one place and charge only once',async()=>{
  const f=await fixture(),m=await f.create();
  await Promise.all(Array.from({length:6},()=>f.t.register(m.id,user())));
  assert.deepEqual(f.charges,[110]);
  assert.equal(f.balances.get(10001),890);
  assert.equal((await f.t.inspect(m.id)).row.current_player,1);
});

test('payment authority can acquire the match lock during charge and refund', {timeout:3000},async()=>{
  let service,charges=0,refunds=0;
  const payments={
    async charge(p){await service.inspect(p.matchId);charges++;return {key:p.key,paidGold:p.gold,paidService:p.service,currency:p.currency};},
    async refund(p){await service.inspect(p.matchId);refunds++;return {key:p.key,currency:p.currency,refunded:p.total};},
  };
  const f=await fixture({matchPayments:payments});service=f.t;const m=await f.create();
  await f.t.register(m.id,user());await f.t.unregister(m.id,user());
  assert.equal(charges,1);assert.equal(refunds,1);assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refunded');
});

test('dev user-center history reads only existing memory and never creates participation or charges',async()=>{
  const f=await fixture(),m=await f.create();
  const query={kind:'matches',startTime:m.start_time-3600000,endTime:m.start_time+3600000,currency:'CNY'};
  const before=f.runtime.tournamentMemory.docs.size;
  assert.deepEqual(await f.t.history(user(99999),query),{matches:[],totalScore:0});
  assert.equal(f.runtime.tournamentMemory.docs.size,before);
  assert.equal(f.charges.length,0);
  await f.t.register(m.id,user());const paid=f.balances.get(10001),charges=f.charges.length;
  const own=await f.t.history(user(),query);assert.equal(own.matches.length,1);assert.equal(own.matches[0].id,m.id);assert.equal(own.totalScore,-110);
  const detail=await f.t.history(user(),{...query,kind:'match',roomId:m.id});assert.equal(detail.match.id,m.id);
  assert.equal(f.charges.length,charges);assert.equal(f.balances.get(10001),paid);
  assert.deepEqual(await f.t.history(user(10001,2),query),{matches:[],totalScore:0});
});
test('insufficient players cancel at the deadline and refund entry and service fees once',async()=>{
  const f=await fixture(),m=await f.create();
  await f.t.register(m.id,user());
  await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,1);
  f.advance(60000);await f.t.tick();await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).row.state,4);
  assert.deepEqual(f.credits,[110]);assert.equal(f.balances.get(10001),1000);
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refunded');
  await assert.rejects(()=>f.t.register(m.id,user(10002)),/截止/);
});
test('failed cancellation refunds persist across hot reload and retry without duplicate credits',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());f.refundFailure(true);
  f.advance(60000);await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refund_pending');
  const reloaded=await createTournaments(f.runtime,f.matches);f.refundFailure(false);
  await reloaded.tick();await reloaded.tick();assert.deepEqual(f.credits,[110]);
});

test('existing zero-policy matches fully refund voluntary withdrawal and administrator cancellation',async()=>{
  for(const action of ['unregister','cancel']){
    const f=await fixture(),m=await f.create();await f.t.register(m.id,user());
    await f.runtime.store.updateMatch(m.id,{refund_service_fee:0});
    if(action==='unregister')await f.t.unregister(m.id,user());else await f.t.cancel(m.id);
    await f.t.tick();assert.deepEqual(f.credits,[110]);assert.equal(f.balances.get(10001),1000);
    const result=await f.t.inspect(m.id);assert.equal(result.row.refund_service_fee,1);
    assert.equal(result.state.registrations[10001].refund.refunded,110);
  }
});
test('declined payment never counts as a registration or receives a refund',async()=>{
  const f=await fixture(),m=await f.create();f.balances.set(10001,109);
  await assert.rejects(()=>f.t.register(m.id,user()),e=>e.status===409);
  f.advance(60000);await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).row.current_player,0);assert.deepEqual(f.credits,[]);
});
test('exact minimum starts only at deadline and only after successful table assignment',async()=>{
  const starts=[],f=await fixture({tournamentTables:{start:async(row,players)=>{
    starts.push(row.id);return [{room_id:81000000,room_index:1,players:players.map(p=>p.userId)}];
  }}}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));
  await f.t.tick();assert.deepEqual(starts,[]);
  f.advance(60000);await f.t.tick();await f.t.tick();
  assert.deepEqual(starts,[m.id]);const {row,state}=await f.t.inspect(m.id);
  assert.equal(row.state,2);assert.equal(row.current_live_player,2);
  assert.equal(state.registrations[10001].roomId,81000000);assert.deepEqual(f.credits,[]);
});

test('missing game state invalidates the running match and refunds both fees once including eliminated participants',async()=>{
  let cleared=0;
  const adapter={start:async(_r,players)=>[{room_id:81000000,players:players.map(p=>p.userId)}],
    status:async()=>{throw Object.assign(new Error('match state lost'),{status:404,reason:'MATCH_STATE_LOST'});},
    advance:async()=>assert.fail('invalid match cannot advance'),invalidate:async()=>{cleared++;return {invalidated:true,released:true};}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  f.runtime.tournamentMemory.docs.get(m.id).registrations[10002].status='eliminated';
  f.runtime.tournamentMemory.docs.get(m.id).registrations[10002].rank=2;
  await f.t.tick();const saved=await f.t.inspect(m.id);
  assert.equal(saved.row.state,4);assert.equal(saved.state.invalidated.reason,'GAME_STATE_LOST');
  assert.equal(saved.state.invalidated.tables[0].room_id,81000000);assert.deepEqual(saved.state.tables,[]);
  assert.equal(saved.state.registrations[10002].invalidRank,2);assert.equal(saved.state.registrations[10002].rank,0);
  assert.deepEqual(f.credits,[110,110]);assert.equal(f.balances.get(10001),1000);assert.equal(f.balances.get(10002),1000);
  assert.equal(cleared,1);const reloaded=await createTournaments(f.runtime,f.matches);await reloaded.tick();await reloaded.tick();
  assert.deepEqual(f.credits,[110,110]);assert.equal(saved.state.awardsPending,false);
  const projection=f.events.filter(e=>e.event==='match_snapshot').map(e=>JSON.parse(e.data)).at(-1);
  assert.equal(projection.match.invalidated,true);assert.equal(projection.match.invalidReason,'GAME_STATE_LOST');
});

test('brief game outages recover without invalidation; sustained failures invalidate only after the grace period',async()=>{
  let unavailable=true;
  const adapter={start:async(_r,players)=>[{room_id:81000000,players:players.map(p=>p.userId)}],
    status:async()=>{if(unavailable)throw Object.assign(new Error('game timeout'),{status:503});return {processId:'original',ready:false};},
    advance:async()=>assert.fail('no checkpoint is ready')};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  await f.t.tick();f.advance(59000);await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,2);
  unavailable=false;await f.t.tick();assert.equal((await f.t.inspect(m.id)).state.gameServerFailure,undefined);
  unavailable=true;await f.t.tick();f.advance(59000);await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,2);
  f.advance(1000);await f.t.tick();const saved=await f.t.inspect(m.id);
  assert.equal(saved.row.state,4);assert.equal(saved.state.invalidated.reason,'GAME_SERVER_UNREACHABLE');assert.deepEqual(f.credits,[110,110]);
});

test('game process replacement invalidates instead of rebuilding seats; failed refunds survive hot update',async()=>{
  let processId='first';
  const adapter={start:async(_r,players)=>[{room_id:81000000,players:players.map(p=>p.userId)}],
    status:async()=>({processId,ready:false}),advance:async()=>assert.fail('cannot advance')};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();await f.t.tick();
  processId='replacement';f.refundFailure(true);await f.t.tick();
  let saved=await f.t.inspect(m.id);assert.equal(saved.state.invalidated.reason,'GAME_SERVER_PROCESS_CHANGED');
  assert.equal(saved.state.registrations[10001].status,'refund_pending');assert.deepEqual(f.credits,[]);
  const reloaded=await createTournaments(f.runtime,f.matches);f.refundFailure(false);await reloaded.tick();await reloaded.tick();
  saved=await reloaded.inspect(m.id);assert.equal(saved.state.registrations[10001].status,'refunded');assert.deepEqual(f.credits,[110,110]);
});
test('missing table dispatch cannot pretend the tournament has started',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());await f.t.register(m.id,user(10002));
  f.advance(60000);await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,1);
  assert.ok(f.errors.some(e=>String(e).includes('牌桌调度')));
});

test('paid late registrations wait for the next checkpoint, add chips once, and cannot reenter after elimination',async()=>{
  let ready=false,admitted=false;
  const players=[{uid:10001,point:10000,openingPoint:10000,roomId:81000000},{uid:10002,point:10000,openingPoint:10000,roomId:81000000}];
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],
    status:async()=>({processId:'same',clock:{currentBlindLv:1},revision:admitted?1:0,ready,players:structuredClone(players)}),
    advance:async(_row,checkpoint)=>{
      assert.equal(checkpoint.admissions.length,1);assert.equal(checkpoint.admissions[0].uid,10003);admitted=true;ready=false;
      players.push({uid:10003,point:10000,openingPoint:10000,roomId:81000000});
      return {processId:'same',players:structuredClone(players),tables:[{room_id:81000000,players:[10001,10002,10003]}]};
    }};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({delay_register_level:2,delay_register_time:120});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  await f.t.register(m.id,user(10003));await f.t.register(m.id,user(10003));
  assert.deepEqual(f.charges,[110,110,110]);assert.equal((await f.t.inspect(m.id)).state.registrations[10003].status,'registered');
  ready=true;await f.t.tick();let saved=await f.t.inspect(m.id);
  assert.equal(saved.state.registrations[10003].status,'playing');assert.equal(saved.state.registrations[10003].roomId,81000000);
  await f.t.tick();assert.equal(players.reduce((n,p)=>n+p.point,0),30000);assert.equal(f.charges.length,3);
  f.runtime.tournamentMemory.docs.get(m.id).registrations[10003].status='eliminated';
  await assert.rejects(()=>f.t.register(m.id,user(10003)),/重入/);
  f.advance(120000);await assert.rejects(()=>f.t.register(m.id,user(10004)),/截止/);assert.equal(f.charges.length,3);
});

test('lost late-admission reply retains the original checkpoint across hot reload',async()=>{
  let lost=true,ready=false;
  const requests=[],players=[{uid:10001,point:10000,openingPoint:10000,roomId:81000000},{uid:10002,point:10000,openingPoint:10000,roomId:81000000}];
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],status:async()=>({revision:0,ready,players:structuredClone(players),clock:{currentBlindLv:1}}),
    advance:async(_r,checkpoint)=>{requests.push(structuredClone(checkpoint));if(lost){lost=false;throw Object.assign(new Error('lost admission response'),{status:503});}
      return {tables:[{room_id:81000000,players:[10001,10002,10003]}],players:[...players,{uid:10003,point:10000,roomId:81000000}]};}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({delay_register_time:120});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();await f.t.register(m.id,user(10003));
  ready=true;await f.t.tick();assert.ok((await f.t.inspect(m.id)).state.checkpoint);
  const reloaded=await createTournaments(f.runtime,f.matches);await reloaded.tick();
  assert.deepEqual(requests[0],requests[1]);assert.equal((await reloaded.inspect(m.id)).state.registrations[10003].status,'playing');
  assert.deepEqual(f.charges,[110,110,110]);
});

test('confirmed late admissions shift prior and current eliminations once while invalid replies preserve the checkpoint',async()=>{
  let phase=0,ready=true,reply='lost';
  const initial=[{uid:10001,point:20000,openingPoint:10000,roomId:81000000},{uid:10002,point:10000,openingPoint:10000,roomId:81000000},{uid:10003,point:0,openingPoint:10000,roomId:81000000}];
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002,10003]}],
    status:async()=>({revision:phase,ready,clock:{currentBlindLv:1},players:phase===0?initial:[{...initial[0],point:30000},{...initial[1],point:0}]}),
    advance:async(_row,checkpoint)=>{
      if(phase===0){phase=1;ready=false;return {players:initial.slice(0,2),tables:[{room_id:81000000,players:[10001,10002]}]};}
      assert.equal(checkpoint.admissions.length,1);assert.equal(checkpoint.admissions[0].uid,10004);
      if(reply==='lost')throw Object.assign(new Error('lost reply'),{status:503});
      const players=[{uid:10001,point:30000,roomId:81000000},{uid:10004,point:10000,roomId:81000000}];
      if(reply==='wrong-points')players[1].point++;
      const tables=[{room_id:81000000,players:reply==='duplicate-seat'?[10001,10001]:[10001,10004]}];
      if(reply==='valid')ready=false;
      return {players,tables};
    }};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({min_player:3,delay_register_time:600});
  for(const uid of [10001,10002,10003])await f.t.register(m.id,user(uid));
  f.advance(60000);await f.t.tick();await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).state.registrations[10003].rank,3);
  await f.t.register(m.id,user(10004));ready=true;await f.t.tick();
  for(const mode of ['wrong-points','duplicate-seat']){
    reply=mode;await f.t.tick();const state=(await f.t.inspect(m.id)).state;
    assert.ok(state.checkpoint);assert.equal(state.registrations[10004].status,'registered');
    assert.equal(state.registrations[10003].rank,3);assert.equal(state.registrations[10002].rank,2);
  }
  reply='valid';const reloaded=await createTournaments(f.runtime,f.matches);await reloaded.tick();
  const state=(await reloaded.inspect(m.id)).state;
  assert.equal(state.checkpoint,undefined);assert.equal(state.registrations[10004].status,'playing');
  assert.deepEqual([10001,10004,10002,10003].map(uid=>state.registrations[uid].rank),[1,2,3,4]);
  await reloaded.tick();assert.equal((await reloaded.inspect(m.id)).state.registrations[10003].rank,4);
  assert.deepEqual(f.charges,[110,110,110,110]);assert.deepEqual(f.credits,[]);
});

test('a late payment confirmed after the deadline is fully refunded before admission',async()=>{
  let serviceFixture,late=false;
  const payments={charge:async p=>{if(late)serviceFixture.advance(120000);return {key:p.key,paidGold:p.gold,paidService:p.service,currency:p.currency};},
    refund:async(p,includeService)=>{assert.equal(includeService,true);return {key:p.key,currency:p.currency,refunded:p.total};}};
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],status:async()=>({ready:false,clock:{currentBlindLv:1}}),advance:async()=>assert.fail('not ready')};
  const f=serviceFixture=await fixture({matchPayments:payments,tournamentTables:adapter}),m=await f.create({delay_register_time:120});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();late=true;
  await assert.rejects(()=>f.t.register(m.id,user(10003)),e=>e.status===503);
  const entry=(await f.t.inspect(m.id)).state.registrations[10003];assert.equal(entry.status,'refunded');assert.equal(entry.refund.refunded,110);assert.equal(entry.roomId,undefined);
});

for(const trigger of ['crash','admin'])test(`rebuy preserves original payment and ${trigger} invalidation refunds every original and reentry payment`,async()=>{
  let phase=0,ready=true,lost=true,missing=false;
  const player=(uid,point)=>({uid,point,openingPoint:10000,roomId:81000000});
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002,10003]}],
    status:async()=>{if(missing)throw Object.assign(new Error('lost state'),{status:404,reason:'MATCH_STATE_LOST'});return {rebuyLimit:1,revision:phase,clock:{currentBlindLv:1},ready,
      players:phase===0?[player(10001,20000),player(10002,10000),player(10003,0)]:phase===1?[player(10001,20000),player(10002,10000)]:[player(10001,30000),player(10002,10000),player(10003,0)]};},
    advance:async(_r,checkpoint)=>{
      if(phase===0){phase=1;ready=false;return {tables:[{room_id:81000000,players:[10001,10002]}],players:[player(10001,20000),player(10002,10000)]};}
      assert.equal(checkpoint.admissions[0].reentry,true);
      if(lost){lost=false;throw Object.assign(new Error('lost rebuy acknowledgment'),{status:503});}
      phase=2;ready=false;return {tables:[{room_id:81000000,players:[10001,10002,10003]}],players:[player(10001,20000),player(10002,10000),player(10003,10000)]};
    },invalidate:async()=>({invalidated:true,released:true})};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({min_player:3,rebuy_time:1,delay_register_time:600});
  for(const uid of [10001,10002,10003])await f.t.register(m.id,user(uid));f.advance(60000);await f.t.tick();await f.t.tick();
  const original=(await f.t.inspect(m.id)).state.registrations[10003].plan.key;
  await Promise.all([f.t.reenter(m.id,user(10003)),f.t.reenter(m.id,user(10003))]);
  let entry=(await f.t.inspect(m.id)).state.registrations[10003];assert.equal(entry.plan.key,original);assert.equal(entry.reentries.length,1);
  assert.equal(entry.reentries[0].status,'registered');assert.equal(f.charges.length,4);assert.equal(f.balances.get(10003),780);
  ready=true;await f.t.tick();assert.ok((await f.t.inspect(m.id)).state.checkpoint);
  const reloaded=await createTournaments(f.runtime,f.matches);await reloaded.tick();
  entry=(await reloaded.inspect(m.id)).state.registrations[10003];assert.equal(entry.status,'playing');assert.equal(entry.reentries[0].status,'admitted');
  await reloaded.reenter(m.id,user(10003));assert.equal(f.charges.length,4,'duplicate confirmed rebuy is idempotent');
  const document=f.runtime.tournamentMemory.docs.get(m.id);document.registrations[10003].status='eliminated';document.registrations[10003].points=0;
  await assert.rejects(()=>reloaded.reenter(m.id,user(10003)),/次数/);
  if(trigger==='crash'){missing=true;await reloaded.tick();}
  else await reloaded.terminate(m.id,{kind:'agent',agentId:1},'operator stop');
  await reloaded.tick();entry=(await reloaded.inspect(m.id)).state.registrations[10003];
  assert.equal(entry.status,'refunded');assert.equal(entry.reentries[0].status,'refunded');assert.equal(f.credits.length,4);
  assert.equal(f.balances.get(10003),1000);assert.equal(f.balances.get(10001),1000);assert.equal(f.balances.get(10002),1000);
  const query={kind:'matches',startTime:m.start_time-1000,endTime:m.start_time+3600000,currency:'CNY'};
  assert.equal((await reloaded.history(user(10003),query)).totalScore,0,'history includes both original and rebuy refunds');
});

test('rebuy remains closed for active players, missing players, and expired windows before charging',async()=>{
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],status:async()=>({rebuyLimit:1,ready:false,clock:{currentBlindLv:1}}),advance:async()=>assert.fail('no settled hand')};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({rebuy_time:1,delay_register_time:120});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  await assert.rejects(()=>f.t.reenter(m.id,user()),/淘汰/);await assert.rejects(()=>f.t.reenter(m.id,user(10003)),/首次/);
  const entry=f.runtime.tournamentMemory.docs.get(m.id).registrations[10002];entry.status='eliminated';entry.points=0;
  f.advance(120000);await assert.rejects(()=>f.t.reenter(m.id,user(10002)),/截止/);assert.deepEqual(f.charges,[110,110]);
});

test('admin termination persists its original audit, cleanup and refund failures retry across reload without extra credits',async()=>{
  let cleanupFails=true;
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],invalidate:async()=>{if(cleanupFails)throw new Error('cleanup unavailable');return {invalidated:true,released:true};}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  f.runtime.tournamentMemory.docs.get(m.id).checkpoint={revision:8,ranks:{10001:1,10002:2}};
  f.refundFailure(true);
  const result=await f.t.terminate(m.id,{kind:'agent',agentId:1},'operator stop');
  assert.equal(result.state,4);assert.equal(result.refundsPending,2);assert.equal(result.tableCleanupPending,true);
  const saved=await f.t.inspect(m.id),at=saved.state.termination.at;
  assert.equal(saved.state.invalidated.reason,'ADMIN_TERMINATED');assert.equal(saved.state.cancelReason,'admin_terminated');
  assert.equal(saved.state.invalidated.checkpoint.revision,8);assert.equal(saved.state.termination.reason,'operator stop');
  assert.deepEqual(saved.state.termination.actor,{kind:'agent',agentId:1});assert.deepEqual(f.credits,[]);
  const reloaded=await createTournaments(f.runtime,f.matches);cleanupFails=false;f.refundFailure(false);await reloaded.tick();
  const repeated=await reloaded.terminate(m.id,{kind:'platform',agentId:1},'operator stop');
  assert.equal(repeated.refundsPending,0);assert.equal(repeated.tableCleanupPending,false);assert.equal(repeated.terminationAt,at);
  assert.deepEqual(f.credits,[110,110]);assert.equal(f.balances.get(10001),1000);assert.equal(f.balances.get(10002),1000);
  await assert.rejects(()=>reloaded.terminate(m.id,{kind:'agent',agentId:1},'changed reason'),e=>e.status===409);
  const projection=f.events.filter(e=>e.event==='match_snapshot').map(e=>JSON.parse(e.data)).at(-1);
  assert.equal(projection.match.terminatedByAdmin,true);assert.equal(projection.match.terminationReason,'operator stop');
});

for(const operation of ['status','advance'])test(`a ${operation} reply arriving after administrator termination cannot recreate standings or finish the match`,async()=>{
  let resolveStatus,entered;
  const statusStarted=new Promise(resolve=>{entered=resolve;});
  const delayed=()=>{entered();return new Promise(resolve=>{resolveStatus=resolve;});};
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],status:()=>operation==='status'?delayed():Promise.resolve({ready:true,revision:0,players:[{uid:10001,point:20000,openingPoint:10000},{uid:10002,point:0,openingPoint:10000}]}),
    advance:()=>operation==='advance'?delayed():assert.fail('terminated match cannot advance'),invalidate:async()=>({invalidated:true,released:true})};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  const pending=f.t.poll(m.id);await statusStarted;
  await f.t.terminate(m.id,{kind:'agent',agentId:1},'stop while polling');
  resolveStatus(operation==='status'?{ready:true,revision:0,players:[{uid:10001,point:20000},{uid:10002,point:0}]}:
    {finished:true,players:[{uid:10001,point:20000,roomId:81000000}],tables:[{room_id:81000000,players:[10001]}]});await pending;
  const saved=await f.t.inspect(m.id);assert.equal(saved.row.state,4);assert.equal(saved.state.checkpoint,undefined);
  assert.equal(saved.state.registrations[10001].status,'refunded');assert.equal(saved.state.registrations[10001].rank,0);assert.deepEqual(f.credits,[110,110]);
});

test('administrator termination checks the owning agent and refuses already finished matches before refunds',async()=>{
  const f=await fixture(),m=await f.create();
  await assert.rejects(()=>f.t.terminate(m.id,{kind:'agent',agentId:2},'foreign stop'),e=>e.status===403);
  await assert.rejects(()=>f.t.terminate(m.id,{kind:'agent',agentId:1},''),e=>e.status===400);
  await f.runtime.store.updateMatch(m.id,{state:3});
  await assert.rejects(()=>f.t.terminate(m.id,{kind:'agent',agentId:1},'finished stop'),e=>e.status===409);assert.deepEqual(f.credits,[]);
});

test('admin termination returns actual mixed-payment cash and original tickets without cashing out the coupon value',async()=>{
  let cashRefunded=0,ticketsRestored=0;
  const payments={charge:async p=>({key:p.key,currency:p.currency,grossGold:p.gold,grossService:p.service,paidGold:80,paidService:10,
    paidTicketCount:21,ticketId:5,ticketCreditAmount:20,creditTicketCount:20,ticketRate:'100'}),
    refund:async p=>{cashRefunded+=90;ticketsRestored+=21;return {key:p.key,currency:p.currency,refunded:90,restoredTickets:21};}};
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],invalidate:async()=>({invalidated:true,released:true})};
  const f=await fixture({matchPayments:payments,tournamentTables:adapter}),m=await f.create({ticket_id:5,register_ticket:1,allow_ticket_pay:1});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  const scope={kind:'agent',agentId:1};await f.t.terminate(m.id,scope,'coupon match stop');await f.t.terminate(m.id,scope,'coupon match stop');
  assert.equal(cashRefunded,180);assert.equal(ticketsRestored,42);assert.equal((await f.t.inspect(m.id)).state.registrations[10001].refund.refunded,90);
});

test('ticket-first registration locks its original allocation and refunds only actual cash plus original tickets',async()=>{
  let charges=0,credits=0,rate='100';
  const payments={charge:async p=>{charges++;return {key:p.key,currency:p.currency,grossGold:p.gold,grossService:p.service,paidGold:80,paidService:10,
    paidTicketCount:21,ticketId:5,ticketCreditAmount:20,creditTicketCount:20,ticketRate:rate};},
    refund:async p=>{credits++;return {key:p.key,currency:p.currency,refunded:90,restoredTickets:21};}};
  const f=await fixture({matchPayments:payments}),m=await f.create({ticket_id:5,register_ticket:1,allow_ticket_pay:1});
  await f.t.register(m.id,user());await f.t.register(m.id,user());
  const original=(await f.t.inspect(m.id)).state.registrations[10001];assert.equal(original.plan.ticketCredit,true);assert.equal(original.receipt.paidGold,80);
  rate='200';await f.t.unregister(m.id,user());await f.t.tick();
  const entry=(await f.t.inspect(m.id)).state.registrations[10001];assert.equal(entry.refund.refunded,90);assert.equal(entry.status,'refunded');assert.equal(charges,1);assert.equal(credits,1);
  const query={kind:'matches',startTime:m.start_time-1000,endTime:m.start_time+1000,currency:'CNY'};assert.equal((await f.t.history(user(),query)).totalScore,0);
});

test('ticket-selected registration pays uncovered fees in cash and selection retries reuse its original allocation',async()=>{
  let charges=0,refunds=0;
  const payments={charge:async p=>{charges++;assert.equal(p.ticketOnly,undefined);return {key:p.key,currency:p.currency,grossGold:p.gold,grossService:p.service,paidGold:80,paidService:10,
    paidTicketCount:21,ticketId:5,ticketCreditAmount:20,creditTicketCount:20,ticketRate:'100'};},
    refund:async p=>{refunds++;return {key:p.key,currency:p.currency,refunded:90,restoredTickets:21};}};
  const f=await fixture({matchPayments:payments}),m=await f.create({register_type:3,ticket_id:5,register_ticket:1,allow_ticket_pay:1});
  await f.t.register(m.id,user(),1);await f.t.register(m.id,user(),1);
  await f.t.register(m.id,user(),2);
  await f.t.unregister(m.id,user());await f.t.tick();
  assert.equal(charges,1);assert.equal(refunds,1);assert.deepEqual(f.charges,[]);assert.deepEqual(f.credits,[]);
  const entry=(await f.t.inspect(m.id)).state.registrations[10001];assert.equal(entry.status,'refunded');assert.equal(entry.refund.refunded,90);
});

test('invalid ticket allocation responses stay pending while both selection retries preserve the original plan',async()=>{
  const requests=[];
  const payments={charge:async p=>{requests.push(structuredClone(p));return {key:p.key,currency:p.currency,grossGold:p.gold,grossService:p.service,paidGold:81,paidService:10,
    paidTicketCount:21,ticketId:5,ticketCreditAmount:20,creditTicketCount:20,ticketRate:'100'};},refund:async()=>assert.fail('no confirmed payment')};
  const f=await fixture({matchPayments:payments}),m=await f.create({register_type:3,ticket_id:5,register_ticket:1,allow_ticket_pay:1});
  await assert.rejects(()=>f.t.register(m.id,user(),1),e=>e.status===503);
  const entry=(await f.t.inspect(m.id)).state.registrations[10001];assert.equal(entry.status,'pending');assert.equal(entry.receipt,undefined);
  await assert.rejects(()=>f.t.register(m.id,user(),2),e=>e.status===503);assert.deepEqual(requests[0],requests[1]);assert.deepEqual(f.charges,[]);
});

test('ticket-selected revival allows cash difference and grants starting chips once at the next checkpoint',async()=>{
  let phase=0,charges=0;
  const p=(uid,point)=>({uid,point,openingPoint:10000,roomId:81000000});
  const payments={charge:async plan=>{charges++;assert.equal(plan.ticketOnly,undefined);return {key:plan.key,currency:plan.currency,grossGold:100,grossService:10,paidGold:80,paidService:10,
    paidTicketCount:21,ticketId:5,ticketCreditAmount:20,creditTicketCount:20,ticketRate:'100'};},refund:async()=>assert.fail('no cancellation')};
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],status:async()=>({revision:phase,rebuyLimit:1,ready:true,clock:{currentBlindLv:1},
    players:phase===0?[p(10001,20000),p(10002,0)]:[p(10001,20000)]}),advance:async(_row,checkpoint)=>{
      if(phase++===0)return {waitingForReentry:true,players:[p(10001,20000)],tables:[{room_id:81000000,players:[10001]}]};
      assert.equal(checkpoint.admissions[0].reentry,true);return {players:[p(10001,20000),p(10002,10000)],tables:[{room_id:81000000,players:[10001,10002]}]};
    }};
  const f=await fixture({matchPayments:payments,tournamentTables:adapter}),m=await f.create({register_type:3,ticket_id:5,register_ticket:1,allow_ticket_pay:1,rebuy_time:1,delay_register_time:300});
  await f.t.register(m.id,user(),1);await f.t.register(m.id,user(10002),1);f.advance(60000);await f.t.tick();await f.t.tick();
  await f.t.reenter(m.id,user(10002),1);await f.t.reenter(m.id,user(10002),1);
  await f.t.reenter(m.id,user(10002),2);
  await f.t.tick();const entry=(await f.t.inspect(m.id)).state.registrations[10002];assert.equal(entry.status,'playing');assert.equal(entry.reentries[0].plan.ticketOnly,undefined);
  assert.equal(entry.reentries[0].status,'admitted');assert.equal(charges,3);assert.deepEqual(f.charges,[]);
});
test('agent isolation, successful registration capacity and deadline are enforced',async()=>{
  const f=await fixture(),m=await f.create({max_player:2});
  await assert.rejects(()=>f.t.register(m.id,user(10003,2)),e=>e.status===403);
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));
  await assert.rejects(()=>f.t.register(m.id,user(10003)),/已满/);
  f.advance(60000);await assert.rejects(()=>f.t.register(m.id,user(10003)),/截止/);
  assert.deepEqual(await f.t.snapshot(user(10001,2)),[]);
});
test('daily schedules create independent next-day occurrences; once schedules do not recur',async()=>{
  const f=await fixture();
  await f.t.saveSchedule(0,{agent_id:1,schedule_kind:'daily',daily_time:'12:00',match:{init_point:10000,min_player:2}});
  await f.t.saveSchedule(0,{agent_id:1,schedule_kind:'once',start_time:Date.parse('2026-10-30T04:00:00Z'),match:{init_point:10000,min_player:2}});
  await f.t.tick();await f.t.tick();
  let rows=(await f.runtime.store.listMatches()).filter(r=>r.create_time===Date.parse('2026-10-30T03:00:00Z')/1000);
  assert.equal(rows.length,2);const firstIds=rows.map(r=>r.id);
  f.advance(3600000);await f.t.tick();
  for(const id of firstIds)assert.equal((await f.t.inspect(id)).row.state,4);
  f.advance(23*3600000);await f.t.tick();
  rows=(await f.runtime.store.listMatches()).filter(r=>r.agent_id===1&&r.init_point===10000);
  assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.state===1).length,1);
});
test('outbox retains failed publish and retries the same snapshot',async()=>{
  const f=await fixture(),m=await f.create();let fail=true;
  f.runtime.bus.publish=async()=>{if(fail)throw new Error('redis unavailable');};
  await assert.rejects(()=>f.t.register(m.id,user()),/redis/);
  assert.equal((await f.t.inspect(m.id)).state.outbox.length,1);
  fail=false;await f.t.flush(m.id);
  assert.equal((await f.t.inspect(m.id)).state.outbox.length,0);assert.deepEqual(f.charges,[110]);
});

test('lost checkpoint reply retains standings; retry finishes once and pays configured prizes once',async()=>{
  let lost=true,notified=0;
  const adapter={start:async(_r,p)=>[{room_id:81000000,players:p.map(e=>e.userId),player_nums:2}],
    status:async()=>({revision:0,ready:true,players:[{uid:10001,point:20000,openingPoint:10000,roomId:81000000},{uid:10002,point:0,openingPoint:10000,roomId:81000000}]}),
    advance:async()=>{if(lost){lost=false;throw new Error('lost table reply');}return {finished:true,players:[{uid:10001,point:20000,roomId:81000000}],tables:[{room_id:81000000,players:[10001],player_nums:1}]};},
    awards:async()=>{notified++;}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({award_json:[{rank:1,items:[{kind:'money',currency:'CNY',amount:'50'}]}]});
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  await f.t.tick();let state=(await f.t.inspect(m.id)).state;
  assert.equal(state.registrations[10002].rank,2);assert.ok(state.checkpoint);
  assert.equal((await f.t.inspect(m.id)).row.state,2);
  await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,3);
  await f.t.tick();await f.t.tick();
  assert.deepEqual(f.credits,[50]);assert.equal(notified,1);
  assert.equal((await f.t.inspect(m.id)).state.awardsPending,false);
});

test('invalid opening stacks cannot persist a new elimination or create an award',async()=>{
  let openingPoint;
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002]}],
    status:async()=>({ready:true,revision:0,players:[{uid:10001,point:20000,openingPoint:10000,roomId:81000000},{uid:10002,point:0,openingPoint,roomId:81000000}]}),
    advance:async()=>assert.fail('invalid elimination evidence cannot advance')};
  const f=await fixture({tournamentTables:adapter}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));f.advance(60000);await f.t.tick();
  for(const invalid of [undefined,0,-1,NaN]){
    openingPoint=invalid;await assert.rejects(()=>f.t.poll(m.id),/settled tournament stack/);
    const saved=await f.t.inspect(m.id);assert.equal(saved.row.state,2);assert.equal(saved.state.registrations[10002].status,'playing');
    assert.equal(saved.state.checkpoint,undefined);assert.equal(saved.state.prizes,undefined);
  }
  assert.deepEqual(f.credits,[]);
});

test('equal-stack eliminations receive distinct numeric-UID places and the full configured prize after a lost reply',async()=>{
  let lost=true,notices=0;const paid=[],paymentReceipts=new Map();
  const winner={uid:10001,point:30000,openingPoint:10000,roomId:81000000};
  const adapter={start:async()=>[{room_id:81000000,players:[10001,10002,10003]}],
    status:async()=>({ready:true,revision:0,players:[{uid:10003,point:0,openingPoint:10000,roomId:81000000},winner,{uid:10002,point:0,openingPoint:10000,roomId:81000000}]}),
    advance:async()=>{if(lost){lost=false;throw new Error('lost ranking response');}return {finished:true,players:[winner],tables:[{room_id:81000000,players:[10001]}]};},
    awards:async()=>{notices++;}};
  const payments={charge:async p=>({key:p.key,currency:p.currency,paidGold:p.gold,paidService:p.service}),refund:async()=>assert.fail('completed match does not refund'),
    award:async p=>{if(paymentReceipts.has(p.key))return paymentReceipts.get(p.key);paid.push(structuredClone(p));const receipt={key:p.key,amount:p.amount,currency:p.currency};paymentReceipts.set(p.key,receipt);return receipt;}};
  const f=await fixture({matchPayments:payments,tournamentTables:adapter}),m=await f.create({min_player:3,award_json:[
    {rank:1,items:[{kind:'money',currency:'CNY',amount:'100'}]},
    {rank:2,items:[{kind:'money',currency:'CNY',amount:'31'}]},
    {rank:3,items:[{kind:'money',currency:'CNY',amount:'10'}]},
  ]});
  for(const uid of [10001,10002,10003])await f.t.register(m.id,user(uid));f.advance(60000);await f.t.tick();await f.t.tick();
  let state=(await f.t.inspect(m.id)).state;
  assert.deepEqual([state.registrations[10002].rank,state.registrations[10003].rank],[3,2]);assert.ok(state.checkpoint);
  const reloaded=await createTournaments(f.runtime,f.matches);await reloaded.tick();await reloaded.tick();await reloaded.tick();
  state=(await reloaded.inspect(m.id)).state;
  assert.deepEqual([state.registrations[10001].rank,state.registrations[10003].rank,state.registrations[10002].rank],[1,2,3]);
  assert.deepEqual(paid.map(p=>[p.userId,p.amount]).sort((a,b)=>a[0]-b[0]),[[10001,100],[10002,10],[10003,31]]);
  assert.equal(notices,1);assert.equal(state.awardsPending,false);assert.equal(paid.length,3);
});

test('duplicate final ranks block payout before an authority request or prize plan is created',async()=>{
  let paid=0;const f=await fixture({matchPayments:{charge:async p=>({key:p.key,currency:p.currency,paidGold:p.gold,paidService:p.service}),refund:async()=>{},award:async()=>{paid++;assert.fail('invalid ranks cannot pay');}}}),m=await f.create();
  await f.t.register(m.id,user());await f.t.register(m.id,user(10002));
  const state=f.runtime.tournamentMemory.docs.get(m.id);
  state.registrations[10001].status='winner';state.registrations[10001].rank=1;
  state.registrations[10002].status='eliminated';state.registrations[10002].rank=1;
  await f.runtime.store.updateMatch(m.id,{state:3});
  await assert.rejects(()=>f.t.awards(m.id),/ranks must be unique/);
  assert.equal((await f.t.inspect(m.id)).state.prizes,undefined);assert.equal(paid,0);
});

test('registration freezes fees, chips, blind template and prize structure',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());
  await assert.rejects(()=>f.t.update(m.id,{register_gold:999}),/锁定/);
  await assert.rejects(()=>f.t.update(m.id,{init_point:999}),/锁定/);
  await f.t.update(m.id,{consults:'[]'});
  assert.equal((await f.t.inspect(m.id)).row.register_gold,100);
});

test('finished match cleanup waits for confirmed awards and retries a lost cleanup reply',async()=>{
  let failAward=true,cleanups=0;
  const adapter={awards:async()=>{if(failAward)throw new Error('notification unavailable');},cleanup:async()=>{cleanups++;if(cleanups===1)throw new Error('lost cleanup reply');return {released:true};}};
  const f=await fixture({tournamentTables:adapter}),m=await f.create({register_gold:0,service_gold:0});
  await f.t.register(m.id,user());
  const document=f.runtime.tournamentMemory.docs.get(m.id);document.registrations[10001].status='winner';document.registrations[10001].rank=1;document.tables=[{room_id:81000000}];
  await f.runtime.store.updateMatch(m.id,{state:3,end_time:m.start_time});
  await f.t.tick();assert.equal(cleanups,0);
  failAward=false;await f.t.tick();assert.equal(cleanups,1);assert.equal((await f.t.inspect(m.id)).state.tablesReleased,undefined);
  await f.t.tick();await f.t.tick();const state=(await f.t.inspect(m.id)).state;
  assert.equal(cleanups,2);assert.equal(state.tablesReleased,true);assert.deepEqual(state.tables,[]);assert.deepEqual(f.credits,[]);
});

test('invalid dates and reward amounts fail before collecting entry money',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.create({start_time:1793358000}),/milliseconds/);
  await assert.rejects(()=>f.create({award_json:[{rank:1,items:[{kind:'money',currency:'CNY',amount:'NaN'}]}]}),/positive integer/);
  assert.deepEqual(f.charges,[]);
});

test('an empty success acknowledgment is not a verified refund',async()=>{
  let verified=false;
  const payments={charge:async p=>({key:p.key,paidGold:p.gold,paidService:p.service,currency:p.currency}),
    refund:async p=>verified?{key:p.key,currency:p.currency,refunded:p.total}:{ok:true}};
  const f=await fixture({matchPayments:payments}),m=await f.create();await f.t.register(m.id,user());f.advance(60000);await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refund_pending');
  verified=true;await f.t.tick();assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refunded');
});
