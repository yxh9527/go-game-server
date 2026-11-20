import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleFinanceControllerFiles,collectibleFinanceHelperFiles} from '../../shared/hot-entry-factory.js';
import {seatFinanceAuthority} from './seat-finance-authority.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {writeHeapSnapshot} from 'node:v8';

export function financeControllerFixture(){return historyFixture([...collectibleFinanceControllerFiles,...collectibleFinanceHelperFiles]);}

if(process.argv.includes('--finance-controller-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(value=>value.startsWith('--revisions='))?.slice('--revisions='.length)||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const growthOption=process.argv.find(value=>value.startsWith('--max-growth-mib='));
  const maxGrowthMiB=growthOption?Number(growthOption.slice('--max-growth-mib='.length)):null;
  assert.ok(maxGrowthMiB===null||Number.isFinite(maxGrowthMiB)&&maxGrowthMiB>0&&maxGrowthMiB<=1024);
  const f=financeControllerFixture(),first=new Map(),weak=[],authority=seatFinanceAuthority(),common=authority.common,sharedRound={};
  authority.add(42,1000);
  const member={uid:42,point:0},boundSession={agentId:7,userId:42,currency:'CNY',authenticated:true};
  const table={agentId:7,gameId:'holdem',roomId:7,roomType:19,kind:'normal',members:[member],observers:[],cfg:{game_type:19,room_type:19,finance_level:1}},registry=createRegistry();
  registry.bind({},boundSession);registry.setTable(7,table,7,'holdem');
  const runtime={registry,wallet:null},samples=[],loop=monitorEventLoopDelay({resolution:10}),started=performance.now();loop.enable();
  let originalIdentity,owned=0;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);if(revision===0)first.set(index,module);
        assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(index)[name]&&typeof value==='function'){refs.push(new WeakRef(value));owned++;}
        if(module.createAuthoritativeWallet){
          const wallet=module.createAuthoritativeWallet({common}),session={agentId:7,userId:42,currency:'CNY'};
          await wallet.load(session);assert.equal(session.wallet,1000);
          runtime.wallet=wallet;await wallet.load(boundSession);
          // Preserve a real funded binding, its token, one resident queue and
          // the same table while each version replaces its executable methods.
          if(revision===0)await wallet.run(()=>wallet.reserveCarry(boundSession,member,table,500),runtime);
          wallet.configureLottery(null);assert.equal(member.point,500);assert.equal(authority.cashCalls.length,1);
          if(revision>0)refs.push(new WeakRef(wallet),new WeakRef(wallet.run),new WeakRef(session));
        }
        if(module.createRoundFinance){
          // The route helper is already one of this fixture's selected imports.
          const {createGameRouteIndex}=await f.load('shared/rpc/game-routes.js',revision);
          const routes=createGameRouteIndex([{gameType:19,roomType:19,number:91019+revision,symbol:'pool-'+revision,state:1,isFrozen:0}]);
          const controller=module.createRoundFinance(common,{routes}),identity=controller.identity(table,sharedRound);
          originalIdentity??=identity;assert.deepEqual(identity,originalIdentity);
          const round={},other=controller.identity(table,round);assert.equal(other.gameId,91019+revision);
          if(revision>0)refs.push(new WeakRef(controller),new WeakRef(controller.bet),new WeakRef(round));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed,stats:f.loader.stats()});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>150);
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released financial controller graph retained');
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,6);assert.equal(stats.compiledEntries,6*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    assert.equal(registry.getTable(7,7,'holdem'),table);assert.equal(member.point,500);assert.equal(authority.cashCalls.length,1);
    if(maxGrowthMiB!==null)assert.ok(samples.at(-1).heapBytes-samples[0].heapBytes<=maxGrowthMiB*1048576,'default-heap retained financial compilation data exceeds '+maxGrowthMiB+' MiB');
    if(process.argv.includes('--snapshot'))writeHeapSnapshot('cache/hot-finance-controller-inside.heapsnapshot');
    console.log('PASS_REAL_FINANCE_CONTROLLERS_GC',JSON.stringify({modules:6,versions:count,owned,stats,samples,durationSeconds:(performance.now()-started)/1000,eventLoopP99Ms:loop.percentile(99)/1e6,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,afterCollectionHeapBytes:process.memoryUsage().heapUsed,carryAmount:member.point,cashCalls:authority.cashCalls.length,limitations:'Isolated controller and account fixture; no network clients, live database or production acceptance.'}));
  }finally{loop.disable();f.close();}
}
