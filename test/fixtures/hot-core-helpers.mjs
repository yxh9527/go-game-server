import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {historyFixture} from './hot-history.mjs';
import {collectibleCoreHelperFiles} from '../../shared/hot-entry-factory.js';

export function coreHelperFixture(){
  const f=historyFixture(collectibleCoreHelperFiles);
  for(const item of f.sources){
    if(item.file.endsWith('member.js')){
      // Only the isolated copy moves; asset lookup still points at the same
      // real, read-only avatar directory as the production source.
      item.source=item.source.replace('"../../../static/avator"',JSON.stringify(fileURLToPath(new URL('../../static/avator',import.meta.url))));
      item.source+='\nexport const hotTestAvatarState=[avatarFiles,avatarFilesById];';
    }
    if(item.file.endsWith('robot-cards.js'))item.source+='\nexport const hotTestSamplingCache=cache;';
    if(item.file.endsWith('slots-reels.js'))item.source+='\nexport const hotTestCompiledCache=compiled;';
  }
  return f;
}

if(process.argv.includes('--core-helper-gc')){
  assert.equal(typeof global.gc,'function');const f=coreHelperFixture(),first=new Map(),weak=[];let owned=0;
  const hand={},profile=Object.freeze({rows:1,strips:Object.freeze([Object.freeze([1,2]),Object.freeze([1,2])])});
  const sampleInput={hand,uid:1,visible:[0],opponents:[{uid:2,cards:null}],size:2,samples:2};
  try{
    for(let revision=0;revision<24;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&value&&(typeof value==='object'||typeof value==='function')){refs.push(new WeakRef(value));owned++;}
        if(module.hotTestAvatarState&&revision>0)for(const value of module.hotTestAvatarState)refs.push(new WeakRef(value));
        if(module.sampleDeals){
          const deals=module.sampleDeals(sampleInput);assert.equal(deals.length,2);
          if(revision>0)refs.push(new WeakRef(deals),new WeakRef(module.hotTestSamplingCache.get(hand)));
        }
        if(module.compileReels){
          const sampler=module.compileReels(profile);assert.equal(module.hotTestCompiledCache.get(profile).sampler,sampler);
          if(revision>0)refs.push(new WeakRef(sampler),...Object.values(sampler).map(value=>new WeakRef(value)));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
    }
    for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>100);assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released core helper or weak-cache value retained');
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    const sampling=[...first.values()].find(module=>module.sampleDeals);assert.equal(sampling.sampleDeals(sampleInput),sampling.hotTestSamplingCache.get(hand).get(1).value);
    const reels=[...first.values()].find(module=>module.compileReels);assert.equal(reels.compileReels(profile),reels.hotTestCompiledCache.get(profile).sampler);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,5);assert.equal(stats.compiledEntries,120);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_CORE_HELPERS_GC',JSON.stringify({modules:5,versions:24,owned,stats}));
  }finally{f.close();}
}
