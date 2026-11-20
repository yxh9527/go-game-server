import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {historyFixture} from './hot-history.mjs';
import {collectibleMatchServiceFiles} from '../../shared/hot-entry-factory.js';
import {createMemoryStore} from '../../cache/rpc/store.js';

export function matchServiceFixture(){return historyFixture(collectibleMatchServiceFiles);}

export function matchServiceRuntime(){
  let at=Date.UTC(2026,10,19,2),failRefund=false;
  const balances=new Map(),charges=[],refunds=[],events=[],errors=[],runtime={env:'dev',hotVersion:'fixture',config:{tournament_scheduler:false},clock:()=>at,store:createMemoryStore(),bus:{publish:async(channel,event)=>events.push({channel,event})},log:{error:(...args)=>errors.push(args)},rpc:{common:{
    debit:async(uid,amount)=>{const balance=balances.get(uid)??1000;if(balance<amount)return {ok:false};balances.set(uid,balance-amount);charges.push({uid,amount});return {ok:true};},
    credit:async(uid,amount)=>{if(failRefund)throw Error('refund unavailable');balances.set(uid,(balances.get(uid)??1000)+amount);refunds.push({uid,amount});return {ok:true};},
  },gateway:{authenticate:async(_token,uid)=>({success:true,userId:uid}),getLoginData:async uid=>({agentId:7,userName:'player-'+uid,currency:{symbol:'CNY'}})}}};
  return {runtime,balances,charges,refunds,events,errors,get at(){return at;},advance(ms){at+=ms;},refundFailure(value){failRefund=value;},user:(userId=42)=>({userId,agentId:7,name:'player-'+userId})};
}

if(process.argv.includes('--match-services-gc')){
  assert.equal(typeof global.gc,'function');const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.slice('--revisions='.length)||24);assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=matchServiceFixture(),x=matchServiceRuntime(),first=new Map(),weak=[],samples=[],started=performance.now();let memory,rowId;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let i=0;i<f.sources.length;i++){
        const module=await f.load(i,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(i,module);const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(i)[name]&&value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.createTournaments){
          const {createMatchService}=await f.load('services/match.js',revision),matches=await createMatchService(x.runtime),service=await module.createTournaments(x.runtime,matches);
          if(revision===0){const row=await matches.create({agent_id:7,championship_name:'[]',state:1,start_time:x.at+60000,init_point:100,min_player:2,max_player:9,register_gold:100,service_gold:10});rowId=row.id;await service.register(row.id,x.user());}
          memory??=x.runtime.tournamentMemory;assert.equal(x.runtime.tournamentMemory,memory);assert.equal((await service.inspect(rowId)).state.registrations[42].status,'registered');assert.equal(x.charges.length,1);assert.equal(x.balances.get(42),890);
          if(revision>0)refs.push(new WeakRef(service),new WeakRef(matches),new WeakRef(service.tick));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released match services retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,14);assert.equal(stats.compiledEntries,14*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_MATCH_SERVICES_GC',JSON.stringify({modules:14,versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,durationSeconds:(performance.now()-started)/1000,sameMemory:true,charges:x.charges.length,balance:x.balances.get(42),limitations:'Isolated dev store/payment fixture and actual service source copies; no remote database or real funds.'}));
  }finally{f.close();}
}
