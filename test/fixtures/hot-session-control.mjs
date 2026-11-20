import assert from 'node:assert/strict';
import {historyFixture} from './hot-history.mjs';
import {collectibleSessionFiles} from '../../shared/hot-entry-factory.js';
import {createRegistry} from '../../game-server/src/registry.js';

export const sessionFixture=()=>historyFixture(collectibleSessionFiles);
export function sessionRuntime(){
  const listeners=new Set(),sent=[],errors=[];let subscriptions=0,unsubscriptions=0;
  const distributed={instanceId:'original-instance',subscribe(fn){subscriptions++;listeners.add(fn);return ()=>{unsubscriptions++;listeners.delete(fn);};},claim:async()=>({ok:true,loginId:'original-login',generation:1,role:'primary'}),release:async()=>true};
  const runtime={registry:createRegistry(),bus:{gameSessions:distributed},log:{info(){},error:(...args)=>errors.push(args)}};
  return {runtime,distributed,sent,errors,listeners,get subscriptions(){return subscriptions;},get unsubscriptions(){return unsubscriptions;},hooks:revision=>({kickId:999,send:(ws,id,payload)=>sent.push({ws,id,payload,revision}),close:async ws=>{runtime.registry.sessions.delete(ws);}}),socket:()=>({readyState:1,close(){this.readyState=3;}}),emit:event=>{for(const listener of listeners)listener(event);}};
}

if(process.argv.includes('--session-control-gc')){
  assert.equal(typeof global.gc,'function');
  const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.split('=')[1]||24);
  assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=sessionFixture(),x=sessionRuntime(),weak=[],samples=[],socket=x.socket();let state,socketState;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let index=0;index<f.sources.length;index++){
        const module=await f.load(index,revision);assert.equal(module.hotTestRevision,revision);
        const refs=[new WeakRef(module)];for(const value of Object.values(module))if(value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.createSessionControl){const control=module.createSessionControl(x.runtime,x.hooks(revision));state??=x.runtime.sessionControl;socketState??=control.socketState(socket);assert.equal(x.runtime.sessionControl,state);assert.equal(control.socketState(socket),socketState);refs.push(new WeakRef(control),new WeakRef(control.accept));}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'resident revocation listener retained an old controller');
    assert.equal(x.subscriptions,1);assert.equal(x.listeners.size,1);assert.equal(socket.readyState,1);
    x.runtime.registry.bind(socket,{userId:42,agentId:7,loginId:'original-login'});x.emit({event:'revoke',loginId:'original-login'});await new Promise(resolve=>setImmediate(resolve));assert.equal(x.sent[0].revision,count-1);assert.equal(socket.readyState,3);
    const stats=f.loader.stats();assert.equal(stats.activeEntries,3);assert.equal(stats.compiledEntries,3*count);assert.equal(stats.pendingEntries,0);
    console.log('PASS_SESSION_CONTROL_GC',JSON.stringify({versions:count,subscriptions:x.subscriptions,stats,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,samples}));
  }finally{x.runtime.sessionControl?.unsubscribe?.();f.close();}
}
