import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {historyFixture} from './hot-history.mjs';
import {collectibleRoomRuntimeFiles} from '../../shared/hot-entry-factory.js';

export function roomRuntimeFixture(){return historyFixture(collectibleRoomRuntimeFiles);}

if(process.argv.includes('--room-runtime-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(value=>value.startsWith('--revisions='))?.slice('--revisions='.length)||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=roomRuntimeFixture(),first=new Map(),weak=[],samples=[],started=performance.now();
  const createdAt=Date.now(),table={kind:'normal',agentId:7,gameId:'holdem',roomId:700000,roomType:19,createdAt,members:[],observers:[],cfg:{game_room_config_id:70}},hundred={inning:1};
  let features,round;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let i=0;i<f.sources.length;i++){
        const module=await f.load(i,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(i,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(i)[name]&&value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.initializeLifetime){module.initializeLifetime(table,Date.now());assert.equal(table.createdAt,createdAt);assert.equal(table.expiresAt,createdAt+8*3600000);}
        if(module.initializeRoomStats){features??=module.initializeRoomStats(table);assert.equal(module.initializeRoomStats(table),features);}
        if(module.financeRound){round??=module.financeRound(hundred);assert.equal(module.financeRound(hundred),round);}
        if(module.hundredWalletContext){const context=module.hundredWalletContext({table},{bot:true});assert.equal(context.table,table);assert.equal(typeof context.wallet.debit,'function');if(revision>0)refs.push(new WeakRef(context),new WeakRef(context.wallet));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released room runtime graph retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,9);assert.equal(stats.compiledEntries,9*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    console.log('PASS_REAL_ROOM_RUNTIME_GC',JSON.stringify({modules:9,versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,durationSeconds:(performance.now()-started)/1000,roomCreatedAtPreserved:table.createdAt===createdAt,limitations:'Isolated real module copies; no remote storage, network clients or money operations.'}));
  }finally{f.close();}
}
