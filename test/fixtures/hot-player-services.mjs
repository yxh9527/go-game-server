import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {historyFixture} from './hot-history.mjs';
import {collectiblePlayerServiceFiles} from '../../shared/hot-entry-factory.js';
import {createRegistry} from '../../game-server/src/registry.js';

export function playerServiceFixture(){return historyFixture(collectiblePlayerServiceFiles);}

if(process.argv.includes('--player-service-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(value=>value.startsWith('--revisions='))?.slice('--revisions='.length)||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=playerServiceFixture(),first=new Map(),weak=[],samples=[],started=performance.now(),runtime={env:'dev',registry:createRegistry(),log:{error(){}}};
  const table={roomId:700000,roomType:19,gameId:'holdem',agentId:7,members:[{uid:42,name:'viewer'},{uid:90000001,name:'bot',bot:true}],observers:[],history:[]},session={userId:42,agentId:7,currency:'CNY',authenticated:true,inRoom:true,roomId:700000,gameId:'holdem'};
  runtime.registry.setTable(700000,table,7,'holdem');let bots,notes,state;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let i=0;i<f.sources.length;i++){
        const module=await f.load(i,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(i,module);
        const refs=[new WeakRef(module)];for(const [name,value]of Object.entries(module))if(value!==first.get(i)[name]&&value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.createPlayerPanel){
          const panel=await module.createPlayerPanel(runtime);panel.syncRoomBots(table);bots??=table.playerPanelBots;notes??=runtime.playerPanelLocalNotes;
          assert.equal(table.playerPanelBots,bots);assert.equal(runtime.playerPanelLocalNotes,notes);assert.equal((await panel.profile(session,table,90000001)).playerId,90000001);
          if(revision>0)refs.push(new WeakRef(panel),new WeakRef(panel.profile));
        }
        if(module.installUserCenter){
          const center=module.installUserCenter(runtime);state??=runtime.userCenterState;assert.equal(runtime.userCenterState,state);assert.equal(center.query({userId:42,agentId:7}).records.length,0);
          if(revision>0)refs.push(new WeakRef(center),new WeakRef(center.query));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released player-service graph retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,6);assert.equal(stats.compiledEntries,6*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    console.log('PASS_REAL_PLAYER_SERVICES_GC',JSON.stringify({modules:6,versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,durationSeconds:(performance.now()-started)/1000,roomProfilesPreserved:table.playerPanelBots===bots,notesPreserved:runtime.playerPanelLocalNotes===notes,reportStatePreserved:runtime.userCenterState===state,limitations:'Isolated module and room fixture; no remote storage or money operations.'}));
  }finally{f.close();}
}
