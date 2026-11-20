import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {parse} from 'acorn';
import {historyFixture} from './hot-history.mjs';
import {collectibleWalletFacadeFiles,collectibleFinanceControllerFiles,collectibleFinanceHelperFiles} from '../../shared/hot-entry-factory.js';
import {performance} from 'node:perf_hooks';

export function walletFacadeFixture(){
  const f=historyFixture([...collectibleWalletFacadeFiles,...collectibleFinanceControllerFiles,...collectibleFinanceHelperFiles]);
  // Copies must keep the original createRequire base and native filesystem
  // argument, so the existing dev class is loaded from its real cache path.
  const index=f.sources.find(item=>item.file.replaceAll('\\','/').endsWith('/wallet/index.js')),edits=[];
  function visit(node){
    if(node.type==='CallExpression'&&node.callee.type==='Identifier'){
      const arg=node.arguments[0];
      if(node.callee.name==='createRequire')edits.push({start:arg.start,end:arg.end,text:JSON.stringify(index.file)});
      if(node.callee.name==='require'&&arg?.type==='Literal'&&typeof arg.value==='string'&&arg.value.startsWith('file:'))edits.push({start:arg.start,end:arg.end,text:JSON.stringify(fileURLToPath(arg.value))});
    }
    for(const value of Object.values(node)){
      if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
      else if(value?.type)visit(value);
    }
  }
  visit(parse(index.source,{ecmaVersion:'latest',sourceType:'module'}));
  for(const edit of edits.sort((a,b)=>b.start-a.start))index.source=index.source.slice(0,edit.start)+edit.text+index.source.slice(edit.end);
  return f;
}

if(process.argv.includes('--wallet-facade-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(value=>value.startsWith('--revisions='))?.slice('--revisions='.length)||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=walletFacadeFixture(),first=new Map(),weak=[],common={async getBalance(){return 1000;}},samples=[],started=performance.now();
  const boundSession={agentId:7,userId:42,currency:'CNY'},member={uid:42,point:0},table={agentId:7,gameId:'holdem',roomId:7,roomType:19};
  let token,current;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let i=0;i<f.sources.length;i++){
        const module=await f.load(i,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(i,module);
        const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(i)[name]&&typeof value==='function')refs.push(new WeakRef(value));
        if(module.createWallet){
          const wallet=module.createWallet({}, {rpc:{common}}),session={userId:42,agentId:7,currency:'CNY'};
          await wallet.load(session);assert.equal(session.wallet,1000);
          await wallet.load(boundSession);current=wallet;
          if(revision===0){wallet.reserveCarry(boundSession,member,table,500);token=wallet.carryRecord(boundSession).token;}
          assert.equal(member.point,500);assert.equal(wallet.carryRecord(boundSession).token,token);assert.equal(boundSession.availableBalance,500);
          assert.equal(module.walletOf({}).mode,'local');
          if(revision>0)refs.push(new WeakRef(wallet),new WeakRef(session));
        }
        if(module.OnlineWallet){const online=new module.OnlineWallet({rpc:{common}});assert.equal(online.mode,'online');if(revision>0)refs.push(new WeakRef(online));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released wallet facade graph retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,11);assert.equal(stats.compiledEntries,11*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    assert.equal(current.carryRecord(boundSession).token,token);assert.equal(member.point,500);
    console.log('PASS_REAL_WALLET_FACADE_GC',JSON.stringify({modules:11,versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,carryAmount:member.point,durationSeconds:(performance.now()-started)/1000,limitations:'Isolated dev account and real wallet source copies, no remote funds or network load.'}));
  }finally{f.close();}
}
