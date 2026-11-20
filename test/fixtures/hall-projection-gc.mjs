import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {hallUserCenterFixture} from './hot-hall-user-center.mjs';

assert.equal(typeof global.gc,'function');
const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.slice('--revisions='.length)||24);
assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
const f=hallUserCenterFixture(),runtime=f.runtime(),weak=[],samples=[],started=performance.now();
let original,watcher;
try{
  for(let revision=0;revision<count;revision++){
    f.write(revision);const module=await f.load();if(revision===0)original=module;
    const reply=await module.userCenterResponse(runtime,27,f.params);assert.equal(reply.msgCode,200);assert.equal(reply.data.revision,revision);
    watcher??=runtime.userCenterProjection.watcher;assert.equal(runtime.userCenterProjection.watcher,watcher);
    weak.push({revision,module:new WeakRef(module),request:new WeakRef(module.userCenterResponse),profile:new WeakRef(module.userCenterProfileResponse)});
    if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    await new Promise(resolve=>setImmediate(resolve));
  }
  for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
  assert.ok(weak.slice(1,-1).every(row=>row.module.deref()===undefined&&row.request.deref()===undefined&&row.profile.deref()===undefined),'the resident watcher retained an old hall business generation');
  assert.equal((await original.userCenterResponse(runtime,27,f.params)).data.revision,count-1,'old caller restored the first projector');
  assert.equal(runtime.userCenterProjection.watcher,watcher);assert.equal(runtime.userCenterProjection.loading,null);
  const stats=f.loader.stats();assert.equal(stats.activeEntries,2);assert.equal(stats.compiledEntries,2*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
  console.log('PASS_RESIDENT_HALL_PROJECTION_GC',JSON.stringify({versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,durationSeconds:(performance.now()-started)/1000,oneWatcher:true,oldCallerUsesLatest:true,limitations:'Isolated actual fs watcher and copied hall/projection modules; no server restart, remote database or money operations.'}));
}finally{f.close();}
