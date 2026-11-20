import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleHallRequestFiles} from '../../shared/hot-entry-factory.js';

export const hallRequestFixture=()=>historyFixture(collectibleHallRequestFiles);
if(process.argv.includes('--hall-requests-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=hallRequestFixture(),weak=[],samples=[];
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];for(const value of Object.values(module))if(typeof value==='function')refs.push(new WeakRef(value));
        if(module.smartBetResponse)assert.deepEqual(module.smartBetResponse({roomType:58,bizType:0,bizParam:'{"roomType":58,"reqType":1}'}).data,{myTasks:[]});
        if(module.requestFairCode)assert.equal((await module.requestFairCode({},{})).msgCode,400);
        if(module.matchRequest)await assert.rejects(module.matchRequest({env:'prod',config:{}},{}),error=>error.code===503);
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released hall request modules retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,3);assert.equal(stats.compiledEntries,3*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_HALL_REQUESTS_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
