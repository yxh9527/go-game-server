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
test('concurrent native registrations reserve one place and charge only once',async()=>{
  const f=await fixture(),m=await f.create();
  await Promise.all(Array.from({length:6},()=>f.t.register(m.id,user())));
  assert.deepEqual(f.charges,[110]);
  assert.equal(f.balances.get(10001),890);
  assert.equal((await f.t.inspect(m.id)).row.current_player,1);
});
test('insufficient players cancel at the deadline and refund entry fee only, once',async()=>{
  const f=await fixture(),m=await f.create();
  await f.t.register(m.id,user());
  await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,1);
  f.advance(60000);await f.t.tick();await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).row.state,4);
  assert.deepEqual(f.credits,[100]);assert.equal(f.balances.get(10001),990);
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refunded');
  await assert.rejects(()=>f.t.register(m.id,user(10002)),/截止/);
});
test('failed cancellation refunds persist across hot reload and retry without duplicate credits',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());f.refundFailure(true);
  f.advance(60000);await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refund_pending');
  const reloaded=await createTournaments(f.runtime,f.matches);f.refundFailure(false);
  await reloaded.tick();await reloaded.tick();assert.deepEqual(f.credits,[100]);
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
test('missing table dispatch cannot pretend the tournament has started',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());await f.t.register(m.id,user(10002));
  f.advance(60000);await f.t.tick();assert.equal((await f.t.inspect(m.id)).row.state,1);
  assert.ok(f.errors.some(e=>String(e).includes('牌桌调度')));
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
    advance:async()=>{if(lost){lost=false;throw new Error('lost table reply');}return {finished:true,players:[{uid:10001,roomId:81000000}],tables:[{room_id:81000000,players:[10001],player_nums:1}]};},
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

test('registration freezes fees, chips, blind template and prize structure',async()=>{
  const f=await fixture(),m=await f.create();await f.t.register(m.id,user());
  await assert.rejects(()=>f.t.update(m.id,{register_gold:999}),/锁定/);
  await assert.rejects(()=>f.t.update(m.id,{init_point:999}),/锁定/);
  await f.t.update(m.id,{consults:'[]'});
  assert.equal((await f.t.inspect(m.id)).row.register_gold,100);
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
    refund:async p=>verified?{key:p.key,currency:p.currency,refunded:p.gold}:{ok:true}};
  const f=await fixture({matchPayments:payments}),m=await f.create();await f.t.register(m.id,user());f.advance(60000);await f.t.tick();
  assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refund_pending');
  verified=true;await f.t.tick();assert.equal((await f.t.inspect(m.id)).state.registrations[10001].status,'refunded');
});
