import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {historyFixture} from './hot-history.mjs';
import {collectibleClientResponseFiles} from '../../shared/hot-entry-factory.js';

export function clientResponseFixture(){
  const f=historyFixture(collectibleClientResponseFiles),root=fileURLToPath(new URL('../../static/',import.meta.url));
  for(const item of f.sources)item.source=item.source.replace('const staticRoot = path.resolve(here, "../../static");','const staticRoot = '+JSON.stringify(root)+';');
  return f;
}

if(process.argv.includes('--client-responses-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=clientResponseFixture(),weak=[],samples=[],first=new Map();
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];for(const [name,value]of Object.entries(module))if(typeof value==='function'&&value!==first.get(index)[name])refs.push(new WeakRef(value));
        if(module.createClientApp){const app=module.createClientApp();refs.push(new WeakRef(app));assert.equal(module.clientVersion(),'2.0.1279');}
        if(module.createAdminRequests){const client=module.createAdminRequests({identity:()=>({token:'test',agent:'7'})});client.dispose();refs.push(new WeakRef(client));}
        if(module.createAdminSubmissions){const submissions=module.createAdminSubmissions();assert.equal(await submissions.submit('form',()=>true),true);refs.push(new WeakRef(submissions));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released client response or admin factories retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,9);assert.equal(stats.compiledEntries,9*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_CLIENT_RESPONSES_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
