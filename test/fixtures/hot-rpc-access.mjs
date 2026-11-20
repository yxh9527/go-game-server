import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleRpcAccessFiles} from '../../shared/hot-entry-factory.js';

export const rpcAccessFixture=()=>historyFixture(collectibleRpcAccessFiles);
export async function rpcAccessServices(f,revision){
  f.write(revision);
  const {CommonRpcProd}=await f.load('commonRpcProd.js',revision),{GatewayRpcProd}=await f.load('gatewayRpcProd.js',revision),{LobbyRpcProd}=await f.load('lobbyRpcProd.js',revision);
  const common=new CommonRpcProd(),gateway=new GatewayRpcProd(),lobby=new LobbyRpcProd();
  return {commonService:common,gatewayService:gateway,lobbyService:lobby,busService:{original:true}};
}

if(process.argv.includes('--rpc-access-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=rpcAccessFixture(),weak=[],samples=[];
  try{
    const rpc=await rpcAccessServices(f,0),common=rpc.commonService,lobby=rpc.lobbyService,gateway=rpc.gatewayService,bus=rpc.busService,owner={pending:new Map()};common.financeOwner=owner;
    const runtime={env:'prod',hotVersion:'rpc-gc-0',rpc};
    for(let revision=0;revision<count;revision++){
      f.write(revision);runtime.hotVersion='rpc-gc-'+revision;
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];for(const value of Object.values(module))if(typeof value==='function')refs.push(new WeakRef(value));
        if(module.refreshDataAccess){await module.refreshDataAccess(runtime);assert.equal(rpc.commonService,common);assert.equal(rpc.lobbyService,lobby);assert.equal(rpc.gatewayService,gateway);assert.equal(rpc.busService,bus);assert.equal(common.financeOwner,owner);}
        if(module.createDataCenterStore){const store=module.createDataCenterStore(async()=>({call:async()=>[]}));assert.deepEqual(await store.listRooms(),[]);refs.push(new WeakRef(store));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released RPC business namespaces retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,6);assert.equal(stats.compiledEntries,6*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_RPC_ACCESS_GC',JSON.stringify({versions:count,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
