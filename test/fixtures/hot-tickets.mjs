import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {historyFixture} from './hot-history.mjs';
import {collectibleTicketFiles} from '../../shared/hot-entry-factory.js';
import config from '../../game-server/src/games/ggl-mjhl/config.js';

// Include the real sampler in the isolated graph to prove its weak cache can
// leave with released ticket factories, even while an old config stays alive.
export function ticketFixture(){return historyFixture([...collectibleTicketFiles,fileURLToPath(new URL('../../game-server/src/core/slots-reels.js',import.meta.url))]);}

if(process.argv.includes('--ticket-gc')){
  assert.equal(typeof global.gc,'function');const f=ticketFixture(),weak=[],first=new Map();let owned=0;
  const routes={resolve:()=>({number:91061})},common={async scratch(operation){assert.equal(operation,'state');return {code:0,pendingTickets:[],denominations:config.denominations,winMultipliers:config.winMultipliers};}};
  const ctx={table:{roomId:61010026,gameRoomId:62010026,roomType:61,cfg:{game_type:1004,finance_level:1},config},session:{agentId:7,userId:42,currency:'CNY',wallet:1000},runtime:{wallet:{guardExternalMoney(){},async load(){}}}};
  try{
    for(let revision=0;revision<24;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&value&&(typeof value==='object'||typeof value==='function')){refs.push(new WeakRef(value));owned++;}
        if(module.createRpcScratchTickets){
          const adapter=module.createRpcScratchTickets(common,{routes});await adapter.state(ctx);
          if(revision>0)refs.push(new WeakRef(adapter),...Object.values(adapter).filter(value=>typeof value==='function').map(value=>new WeakRef(value)));
        }
        if(module.scratchCandidates){const plan=module.scratchCandidates(config.reelProfile,100,{rng:()=>0n});assert.equal(plan.length,3);if(revision>0)refs.push(new WeakRef(plan),...plan.map(value=>new WeakRef(value)));}
        if(module.compileReels){const sampler=module.compileReels(config.reelProfile);assert.equal(sampler.distribution().size,21);if(revision>0)refs.push(new WeakRef(sampler));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
    }
    for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>100);assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released ticket adapter/plan graph retained');
    const owner=common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.tasks.size,0);assert.equal(owner.pendingCounts.size,0);
    const original=[...first.values()].find(module=>module.createRpcScratchTickets);assert.equal((await original.createRpcScratchTickets(common,{routes}).state(ctx)).code,0);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,4);assert.equal(stats.compiledEntries,96);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_TICKET_GC',JSON.stringify({modules:4,versions:24,owned,stats}));
  }finally{f.close();}
}
