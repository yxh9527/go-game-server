import assert from 'node:assert/strict';
import path from 'node:path';
import {historyFixture} from './hot-history.mjs';
import {collectibleRuleFiles} from '../../shared/hot-entry-factory.js';
import config from '../../game-server/src/games/baccarat/config.js';

export function pricingFixture(){
  const fixture=historyFixture(collectibleRuleFiles);
  for(const item of fixture.sources){
    if(item.file.endsWith(path.join('baccarat','odds.js')))item.source+='\nexport const hotTestPricingCache=baseProbabilities;';
    if(item.file.endsWith('turntable-rules.js'))item.source+='\nexport const hotTestWheelProfiles=profiles;';
  }
  return fixture;
}

if(process.argv.includes('--pricing-gc')){
  assert.equal(typeof global.gc,'function');const f=pricingFixture(),first=new Map(),weak=[];let owned=0;
  try{
    for(let revision=0;revision<24;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&value&&(typeof value==='object'||typeof value==='function')){refs.push(new WeakRef(value));owned++;}
        if(module.hotTestPricingCache&&[0,1,23].includes(revision)){
          module.brightOdds([3,5,13,14,15,16,17,18],{other:3,banker:5},{...config,decks:1});
          const probability=module.hotTestPricingCache.get(1);assert.ok(probability);
          if(revision===1)refs.push(new WeakRef(probability),...probability.map(value=>new WeakRef(value)));
        }
        if(module.hotTestWheelProfiles&&revision>0)for(const profile of Object.values(module.hotTestWheelProfiles))refs.push(new WeakRef(profile),new WeakRef(profile.odds),new WeakRef(profile.outer));
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
    }
    for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>100);assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released pricing cache or rule graph retained');
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    const base=[...first.values()].find(module=>module.hotTestPricingCache);assert.ok(base.hotTestPricingCache.get(1),'retained original cache lost');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,5);assert.equal(stats.compiledEntries,120);assert.equal(stats.weakVersions,120);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_PRICING_GC',JSON.stringify({modules:5,versions:24,owned,stats}));
  }finally{f.close();}
}
