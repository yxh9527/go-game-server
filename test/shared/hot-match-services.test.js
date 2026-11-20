import test from 'node:test';
import assert from 'node:assert/strict';
import {matchServiceFixture,matchServiceRuntime} from '../fixtures/hot-match-services.mjs';
import {ensureTournamentScheduler} from '../../match/src/scheduler-loop.js';
import {collectibleMatchServiceFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';
import {pathToFileURL} from 'node:url';

async function services(f,x,revision){
  f.write(revision);
  const {createMatchService}=await f.load('services/match.js',revision);
  const matches=await createMatchService(x.runtime);
  const {createTournaments}=await f.load('tournaments.js',revision);
  return {matches,tournaments:await createTournaments(x.runtime,matches)};
}

test('match business factories are selected while scheduler transport stays resident',()=>{
  const loader=createCollectibleEntryLoader();
  assert.equal(collectibleMatchServiceFiles.length,14);
  assert.equal(collectibleModuleFiles.length,242);
  for(const file of collectibleMatchServiceFiles)assert.equal(loader.handles(pathToFileURL(file).href),true);
  assert.equal(loader.handles(new URL('../../match/src/scheduler-loop.js',import.meta.url).href),false);
});

test('match replacement preserves registration and refunds the original payment once',async()=>{
  const f=matchServiceFixture(),x=matchServiceRuntime();
  try{
    const a=await services(f,x,0);
    const row=await a.matches.create({agent_id:7,championship_name:'[]',state:1,start_time:x.at+60000,init_point:100,min_player:2,max_player:9,register_gold:100,service_gold:10});
    await a.tournaments.register(row.id,x.user());
    const memory=x.runtime.tournamentMemory,b=await services(f,x,1);
    assert.equal(x.runtime.tournamentMemory,memory);
    await b.tournaments.register(row.id,x.user());
    assert.equal(x.charges.length,1);assert.equal(x.balances.get(42),890);
    x.refundFailure(true);await b.tournaments.cancel(row.id);
    assert.equal((await b.tournaments.inspect(row.id)).state.registrations[42].status,'refund_pending');
    assert.equal(x.refunds.length,0);
    const c=await services(f,x,2);x.refundFailure(false);
    await c.tournaments.cancel(row.id);await a.tournaments.cancel(row.id);
    assert.equal(x.refunds.length,1);assert.equal(x.balances.get(42),1000);
    assert.equal((await c.tournaments.inspect(row.id)).row.state,4);
  }finally{f.close();}
});

test('resident scheduler retains its timer and excludes overlapping work after replacement',async t=>{
  t.mock.timers.enable({apis:['setInterval']});
  let release,oldCalls=0,newCalls=0;
  const loop={busy:false,work:()=>{oldCalls++;return new Promise(resolve=>{release=resolve;});}};
  try{
    ensureTournamentScheduler(loop);const timer=loop.timer;
    t.mock.timers.tick(1000);assert.equal(oldCalls,1);assert.equal(loop.busy,true);
    loop.work=async()=>{newCalls++;};ensureTournamentScheduler(loop);
    assert.equal(loop.timer,timer);t.mock.timers.tick(3000);assert.equal(newCalls,0);
    release();await new Promise(resolve=>setImmediate(resolve));
    t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(newCalls,1);assert.equal(loop.busy,false);
  }finally{release?.();clearInterval(loop.timer);}
});
