import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleFinanceHelperFiles} from '../../shared/hot-entry-factory.js';

export function financeHelperFixture(){return historyFixture(collectibleFinanceHelperFiles);}

if(process.argv.includes('--finance-helper-gc')){
  assert.equal(typeof global.gc,'function');const f=financeHelperFixture(),first=new Map(),weak=[];let owned=0;
  try{
    for(let revision=0;revision<24;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&typeof value==='function'){refs.push(new WeakRef(value));owned++;}
        if(module.createGameRouteIndex){
          const routes=module.createGameRouteIndex([{gameType:19,roomType:19,number:91019,symbol:'holdem',state:1,isFrozen:0}]);
          assert.equal(routes.resolve(19,19).number,91019);if(revision>0)refs.push(new WeakRef(routes),new WeakRef(routes.resolve),new WeakRef(routes.list));
        }
        if(module.captureGameState){
          const table={point:100},runtime={registry:{tables:new Map([[1,table]]),sessions:new Map()}};
          const restore=module.captureGameState(runtime);table.point=99;restore();assert.equal(table.point,100);if(revision>0)refs.push(new WeakRef(restore));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
    }
    for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>100);assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released finance helper graph retained');
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    const money=[...first.values()].find(module=>module.scoreToMoney);assert.equal(money.scoreToMoney(101),'1.01');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,3);assert.equal(stats.compiledEntries,72);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_FINANCE_HELPERS_GC',JSON.stringify({modules:3,versions:24,owned,stats}));
  }finally{f.close();}
}
