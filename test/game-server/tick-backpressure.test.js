import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {createGameSessionStore} from '../../shared/rpc/game-session-store.js';

test('slow monetary ticks coalesce across intervals/hot updates and renew sessions only at the outer level',async()=>{
  const registry=createRegistry(),context=new AsyncLocalStorage();let release,runs=0,renewals=0;
  const gate=new Promise(resolve=>{release=resolve;}),store=createGameSessionStore({instanceId:'tick-pressure'});
  store.renew=async()=>{renewals++;return true;};
  registry.bind({readyState:1},{userId:42,agentId:7,authenticated:true,loginId:'login'});
  for(let id=1;id<=10;id++)registry.setTable(id,{roomId:id,roomType:-1,gameId:'noop',kind:'other',members:[]},7,'noop');
  const runtime={env:'dev',hotVersion:'tick-pressure',registry,configs:[],findConfig:()=>null,bus:{gameSessions:store},
    wallet:{authoritative:true,managed:()=>context.getStore()===true,guardCashTable(){},
      run(action){runs++;return gate.then(()=>context.run(true,action));}},log:{info(){},error(){}}};
  let handler=await createHandler(runtime);
  const first=handler.tick();
  for(let i=0;i<100;i++)assert.equal(handler.tick(),first);
  assert.equal(runs,10,'later timer events must not enqueue another round of table transactions');
  runtime.hotVersion+='-next';handler=await createHandler(runtime);assert.equal(handler.tick(),first);
  const outerRenewals=renewals;
  release();await first;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(renewals,outerRenewals,'the ten internal per-table calls must not renew the whole session registry ten more times');
  await handler.tick();assert.equal(runs,20);assert.equal(renewals,outerRenewals+1);await store.close();
});
