import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {tournamentFixture,tournamentRuntime} from '../fixtures/hot-tournament.mjs';
import {collectibleTournamentFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
async function controller(f,x,revision){
  f.write(revision);const module=await f.load('core/tournament.js',revision),control=await module.createTournamentControl(x.runtime,()=>x.game,x.io),signer=await f.load('shared/tournament-control.js',revision);
  return {control,async call(action,patch={}){let result;await control.handle({readyState:1,send:raw=>{result=JSON.parse(raw);}},signer.signControl(x.secret,{action,agentId:7,matchId:99,...patch}));return result;}};
}

test('eight tournament modules use factories while runtime, transport timer and session owners stay resident',()=>{
  assert.equal(collectibleTournamentFiles.length,8);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleTournamentFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/tournament-dedup-timer.js','../../game-server/src/registry.js','../../shared/session-revocation-listener.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('a pending original start shares the request owner across code replacement without allocating a second match',async()=>{
  const f=tournamentFixture(),x=tournamentRuntime();let release;try{
    let reads=0;x.runtime.rpc.lobby.getMatch=()=>{reads++;return new Promise(resolve=>{release=()=>resolve({agent_id:7,state:2});});};
    const first=await controller(f,x,0),payload=x.start(),pending=first.call('start',payload);await turn();assert.equal(reads,1);
    const state=x.runtime.tournamentIdempotency,timer=state.timer,next=await controller(f,x,1),joined=next.call('start',payload);await turn();assert.equal(reads,1);assert.equal(x.runtime.tournamentIdempotency,state);assert.equal(state.timer,timer);
    release();const [a,b]=await Promise.all([pending,joined]);assert.equal(a.code,200);assert.deepEqual(a,b);assert.equal(x.runtime.tournamentRooms.matches.size,1);assert.equal(x.runtime.registry.tables.size,1);assert.equal(state.pending.size,0);
    assert.equal((await next.call('start',payload)).data.processId,a.data.processId);assert.equal(reads,1);
  }finally{release?.();x.close();f.close();}
});

test('manual pause clock and late-registration delay survive replacement and repeated resume never extends them',async()=>{
  const f=tournamentFixture(),x=tournamentRuntime();try{
    const a=await controller(f,x,0);assert.equal((await a.call('start',x.start())).code,200);const m=x.runtime.tournamentRooms.matches.get('7:99'),table=m.tables[0],clock=m.clock;
    table.hand={};table.phase='playing';x.advance(10000);const paused=await a.call('pause',{paused:true,pauseVersion:1});assert.equal(paused.data.clock.pauseAt,null);
    table.hand=null;table.phase='idle';table.mtt.paused=true;table.startAt=x.at+3000;x.advance(3000);assert.equal((await a.call('status')).data.clock.pauseAt,x.at);const pauseAt=x.at;
    const b=await controller(f,x,1);x.advance(120000);assert.equal((await b.call('status')).data.clock.pauseAt,pauseAt);assert.equal(m.clock,clock);assert.equal(m.tables[0],table);
    const resumed=await b.call('pause',{paused:false,pauseVersion:2});assert.equal(resumed.code,200);assert.equal(resumed.data.clock.registrationDelayMs,120000);const deadline=resumed.data.clock.nextBlindAt;x.advance(1000);
    assert.equal((await a.call('pause',{paused:false,pauseVersion:2})).data.clock.nextBlindAt,deadline);assert.equal((await b.call('pause',{paused:true,pauseVersion:1})).data.clock.pauseRequested,false);assert.equal(m.clock.registrationDelayMs,120000);
  }finally{x.close();f.close();}
});

test('automatic pause waits for the original animation and replacement resumes into the next level once',async()=>{
  const f=tournamentFixture(),x=tournamentRuntime();try{
    const a=await controller(f,x,0),payload=x.start();payload.config.levels=[{type:1,min:5,max:10,interval:60},{type:2},{type:1,min:10,max:20,interval:0}];await a.call('start',payload);const m=x.runtime.tournamentRooms.matches.get('7:99'),table=m.tables[0];table.hand={};table.phase='playing';x.advance(61000);
    const waiting=await a.call('status');assert.equal(waiting.data.clock.pauseAt,null);assert.equal(waiting.data.clock.autoPauseIndex,1);const b=await controller(f,x,1);assert.equal((await b.call('pause',{paused:false,pauseVersion:2})).code,409);
    table.hand=null;table.phase='idle';table.mtt.paused=true;table.startAt=x.at+3000;x.advance(3000);assert.equal((await b.call('status')).data.clock.pauseAt,x.at);x.advance(60000);
    const resumed=await b.call('pause',{paused:false,pauseVersion:2});assert.equal(resumed.data.clock.bigBlind,20);assert.equal(resumed.data.clock.completedPauseIndex,1);assert.equal(resumed.data.clock.registrationDelayMs,60000);
    a.control.tick();assert.equal((await a.call('status')).data.clock.autoPauseIndex,null);assert.equal((await a.call('pause',{paused:false,pauseVersion:2})).data.clock.registrationDelayMs,60000);
  }finally{x.close();f.close();}
});

test('checkpoint and final award acknowledgements remain unique across replacement and cleanup never creates cash payouts',async()=>{
  const f=tournamentFixture(),x=tournamentRuntime();try{
    const a=await controller(f,x,0),start=await a.call('start',x.start()),m=x.runtime.tournamentRooms.matches.get('7:99'),table=m.tables[0];const processId=start.data.processId;
    table.phase='idle';table.startAt=0;table.mtt.paused=true;const b=await controller(f,x,1);assert.equal((await b.call('advance',{revision:0})).data.revision,1);assert.equal(m.revision,1);
    assert.equal((await a.call('advance',{revision:0})).code,200);assert.equal(m.revision,1);assert.equal(x.runtime.tournamentRooms.processId,processId);
    table.phase='idle';table.startAt=0;table.mtt.paused=true;table.members[1].point=0;table.members[0].point=200;x.advance(121000);const finished=await b.call('advance',{revision:1});assert.equal(finished.data.finished,true);
    assert.equal((await b.call('awards',{results:[{uid:42,rank:1,award:10,ticketNum:0},{uid:43,rank:1,award:0,ticketNum:0}]})).code,400);
    const results=[{uid:42,rank:1,award:10,ticketNum:0},{uid:43,rank:2,award:0,ticketNum:0}];assert.equal((await b.call('awards',{results})).code,200);const final=m.finalResults,events=x.events.length;
    const c=await controller(f,x,2);assert.equal((await c.call('awards',{results})).code,200);assert.equal(m.finalResults,final);assert.equal(x.events.length,events);assert.equal((await c.call('awards',{results:[{...results[0],award:11},results[1]]})).code,409);
    assert.equal((await c.call('cleanup')).data.released,true);assert.equal(x.runtime.registry.tables.size,0);assert.equal(x.runtime.tournamentRooms.matches.size,0);assert.equal((await a.call('cleanup')).data.released,true);assert.equal(table.members.length,0);
  }finally{x.close();f.close();}
});

test('the original request timer, pending operations and completion deadline remain shared across idempotency replacement',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});const f=tournamentFixture(),runtime={};let release;try{
    f.write(0);const old=await f.load('shared/tournament-idempotency.js',0),a=old.createTournamentIdempotency(runtime);let runs=0;await a.run('finished',()=>({runs:++runs}));const state=runtime.tournamentIdempotency,expiry=state.entries.get('finished').expiresAt,timer=state.timer;
    const pending=a.run('pending',()=>new Promise(resolve=>{release=resolve;}));await Promise.resolve();t.mock.timers.tick(10000);
    f.write(1);const next=await f.load('shared/tournament-idempotency.js',1),b=next.createTournamentIdempotency(runtime);assert.equal(state.timer,timer);assert.equal(state.entries.get('finished').expiresAt,expiry);assert.deepEqual(await b.run('finished',()=>assert.fail('duplicate work')),{runs:1});
    t.mock.timers.tick(old.TOURNAMENT_DEDUP_TTL_MS);assert.equal(state.entries.size,0);const joined=b.run('pending',()=>assert.fail('pending work replayed'));release({ok:true});await Promise.all([pending,joined]);assert.equal(state.pending.size,0);assert.equal(state.entries.get('pending').expiresAt,Date.now()+old.TOURNAMENT_DEDUP_TTL_MS);
  }finally{release?.({ok:true});clearInterval(runtime.tournamentIdempotency?.timer);f.close();}
});

test('signatures and unique numeric UID ranking rules remain compatible across old and new modules',async()=>{
  const f=tournamentFixture();try{
    f.write(0);const old=await f.load('shared/tournament-control.js',0),packet=old.signControl('private',{action:'status',agentId:7,matchId:99},100000);f.write(1);const next=await f.load('shared/tournament-control.js',1);assert.equal(next.verifyControl('private',packet,100001).matchId,99);assert.throws(()=>next.verifyControl('wrong',packet,100001),{status:403});assert.throws(()=>next.verifyControl('private',packet,131000),{status:403});
    const rank=await f.load('shared/tournament-ranking.js',1);assert.deepEqual(rank.tournamentEliminationOrder([{uid:43,point:0,openingPoint:100},{uid:42,point:0,openingPoint:100}]).map(p=>p.uid),[42,43]);assert.throws(()=>rank.validateTournamentFinalRanks([{uid:42,rank:1},{uid:43,rank:1}]),/unique/);
  }finally{f.close();}
});

test('a legacy sweep timer is replaced once without dropping original cache entries or pending work',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});const f=tournamentFixture();let legacyTicks=0;
  const original=setInterval(()=>legacyTicks++,1000),entry={value:{ok:true},expiresAt:3700000},pending=Promise.resolve({pending:true}),runtime={tournamentIdempotency:{timer:original,entries:new Map([['original',entry]]),pending:new Map([['original-pending',pending]])}};
  try{
    f.write(0);const old=await f.load('shared/tournament-idempotency.js',0);old.createTournamentIdempotency(runtime);const state=runtime.tournamentIdempotency,timer=state.timer;
    assert.notEqual(timer,original);assert.equal(state.entries.get('original'),entry);assert.equal(state.pending.get('original-pending'),pending);
    f.write(1);const next=await f.load('shared/tournament-idempotency.js',1);next.createTournamentIdempotency(runtime);assert.equal(state.timer,timer);t.mock.timers.tick(60000);assert.equal(legacyTicks,0);assert.equal(state.entries.get('original').expiresAt,3700000);
  }finally{clearInterval(runtime.tournamentIdempotency.timer);clearInterval(original);f.close();}
});

test('released tournament modules and controllers are collected while original match, clock and timer survive',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-tournament.mjs','--tournament-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_TOURNAMENT_GC/);
});
