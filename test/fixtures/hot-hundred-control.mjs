import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleHundredControlFiles} from '../../shared/hot-entry-factory.js';

export const hundredControlFixture=()=>historyFixture(collectibleHundredControlFiles);
export function smartRuntime(){
  let records=0,bets=0;
  const table={roomId:5801,roomType:58,agentId:7,state:2,inning:1,playerBets:new Map(),recordUserCenter(){records++;}};
  const session={userId:42,agentId:7,currency:'CNY',authenticated:true,inRoom:true,hundredRoomIds:new Set([5801])};
  const registry={tables:new Map([[5801,table]]),sessions:new Map([[42,session]]),getTable:id=>id===5801?table:null,setTable(id,value){this.tables.set(id,value);return value;}};
  const runtime={env:'dev',registry,log:{error(){}}};
  const game={id:'baccarat',betState:()=>2,betOptions:()=>({areas:[{areaId:1}],minBet:1,maxBet:1000}),placeBet(ctx,request){bets++;table.playerBets.set(42,request.params);ctx.send(0,{code:0});return true;}};
  return {runtime,table,session,game,io:{},user:{userId:42,agentId:7,currency:'CNY'},request:{action:'create',strategy:'FIXED',roomType:58,roomId:5801,areaId:1,betAmount:100,stopCountLimit:2,requestId:'same-request'},get bets(){return bets;},get records(){return records;}};
}

if(process.argv.includes('--hundred-control-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=hundredControlFixture(),x=smartRuntime(),weak=[],samples=[];let owner,task;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];for(const value of Object.values(module))if(typeof value==='function')refs.push(new WeakRef(value));
        if(module.createSmartBet){
          const smart=module.createSmartBet(x.runtime,()=>x.game,()=>x.io);
          if(revision===0){const created=await smart.command(x.user,x.request);task=x.runtime.smartBetState.tasks.get(created.taskId);await smart.tick(x.table);}
          owner??=x.runtime.smartBetState;assert.equal(x.runtime.smartBetState,owner);assert.equal(x.table.smartTasks.get(task.taskId),task);assert.equal(x.bets,1);
          await smart.tick(x.table);refs.push(new WeakRef(smart),new WeakRef(smart.tick));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released hundred control modules retained by hooks');
    x.table.recordUserCenter([{uid:42,score:100}],{inning:1});assert.equal(x.records,1);assert.equal(task.completedCount,1);assert.equal(task.profit,100);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,4);assert.equal(stats.compiledEntries,4*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_HUNDRED_CONTROL_GC',JSON.stringify({versions:count,stats,bets:x.bets,records:x.records,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{f.close();}
}
