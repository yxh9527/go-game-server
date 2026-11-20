import assert from 'node:assert/strict';
import {importHotModule} from '../../shared/hot-import.js';
const {captureGameState}=await importHotModule(new URL('../../game-server/src/wallet/transaction-state.js',import.meta.url).href,'transaction-snapshot-gc');
assert.equal(typeof global.gc,'function');
const retained=[],weak=[];
// Keep completed callbacks and the caller runtime alive. Their old captured
// hands, sessions, socket keys and ignored state still need to be collectable.
async function allocate(mode){
  const member={point:100},hand={pot:10,member,cards:Array(1024).fill(1)},session={userId:42,authenticated:true,member},socket={id:1},ignored={balance:1000};
  const runtime={wallet:{},registry:{tables:new Map([[1,{member,hand,ignored}]]),sessions:new Map([[socket,session]])}};
  const restore=captureGameState(runtime,[ignored]);
  if(mode==='restored'){member.point=50;restore();assert.equal(member.point,100);}
  else if(mode==='discarded'){member.point=150;restore.discard();restore();assert.equal(member.point,150);}
  else{
    Object.defineProperty(member,'point',{value:50,writable:false,configurable:false});assert.throws(restore,TypeError);
  }
  runtime.registry.tables.clear();runtime.registry.sessions.clear();
  retained.push({restore,runtime});weak.push(...[member,hand,session,socket,ignored].map(value=>new WeakRef(value)));
  await new Promise(resolve=>setImmediate(resolve));
}
for(let i=0;i<120;i++)await allocate(['restored','discarded','failed'][i%3]);
for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
assert.ok(weak.every(ref=>ref.deref()===undefined),'completed callback retained old hand/session/socket or ignored state');
for(const item of retained){assert.doesNotThrow(item.restore);assert.equal(item.runtime.registry.tables.size,0);assert.equal(item.runtime.registry.sessions.size,0);}
console.log('PASS_TRANSACTION_SNAPSHOT_GC',JSON.stringify({completedCallbacks:retained.length,collectedObjects:weak.length,modes:['restored','discarded','failed']}));
