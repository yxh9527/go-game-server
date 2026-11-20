import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleRemainingBusinessFiles} from '../../shared/hot-entry-factory.js';
export const remainingBusinessFixture=()=>historyFixture(collectibleRemainingBusinessFiles);
if(process.argv.includes('--remaining-business-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=600);
  const f=remainingBusinessFixture(),weak=[],samples=[],first=new Map();
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released remaining config/helper graph retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,38);assert.equal(stats.compiledEntries,38*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_REMAINING_BUSINESS_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
