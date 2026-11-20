import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {historyFixture} from './hot-history.mjs';
import {collectibleHallWebFiles} from '../../shared/hot-entry-factory.js';

export function hallWebFixture(){
  const f=historyFixture(collectibleHallWebFiles);
  // Source copies use the original read-only asset directories, not cache/.
  const root=fileURLToPath(new URL('../../static/',import.meta.url));
  for(const item of f.sources){
    item.source=item.source.replace('const staticRoot = path.resolve(here, "../../static");','const staticRoot = '+JSON.stringify(root)+';');
    item.source=item.source.replace("const clientRoot=fileURLToPath(new URL('../static/client/',import.meta.url));",'const clientRoot='+JSON.stringify(path.join(root,'client'))+';');
  }
  return f;
}

if(process.argv.includes('--hall-web-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=hallWebFixture(),weak=[],samples=[];
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];for(const value of Object.values(module))if(typeof value==='function')refs.push(new WeakRef(value));
        if(module.mountWeb){const app=express();module.mountWeb(app,{config:{}});refs.push(new WeakRef(app));assert.equal(module.clientVersion(),'2.0.1279');}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released hall web modules or mounted apps retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,4);assert.equal(stats.compiledEntries,4*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_HALL_WEB_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
