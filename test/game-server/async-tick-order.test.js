import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';

async function fixture(){
  const runtime={env:'dev',hotVersion:'async-tick-retirement',registry:createRegistry(),configs:[],findConfig:()=>null,wallet:{guardCashTable(){}},log:{info(){},warn(){},error(){}}};
  const handler=await createHandler(runtime),game=handler.games.byRoomType.get(53),table=game.createTable(700001,53,{game_room_config_id:70,room_type:53});table.agentId=7;
  runtime.registry.setTable(table.roomId,table,7,game.id);return {runtime,handler,game,table};
}

test('asynchronous room retirement is evaluated after engine completion without another tick',async()=>{
  const f=await fixture(),original=f.game.tick,originalAfter=f.game.afterRound;let release,started;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;}),order=[];
  f.game.tick=async()=>{order.push('start');started();await gate;f.table.retired=true;order.push('finished');};
  let calls=0;f.game.afterRound=()=>{if(++calls>1){assert.equal(f.table.retired,true);order.push('cleanup');}};
  try{
    const ticking=f.handler.tick();await entered;assert.deepEqual(order,['start']);assert.equal(f.runtime.registry.getTable(f.table.roomId,7,f.game.id),f.table);
    release();await ticking;assert.deepEqual(order,['start','finished','cleanup']);assert.equal(f.runtime.registry.getTable(f.table.roomId,7,f.game.id),null);
  }finally{release();f.game.tick=original;f.game.afterRound=originalAfter;}
});

test('synchronous engine tick still runs its post-round cleanup immediately',async()=>{
  const f=await fixture(),original=f.game.tick,originalAfter=f.game.afterRound,order=[];let calls=0;
  f.game.afterRound=()=>{order.push(++calls===1?'admission':'cleanup');};f.game.tick=()=>{order.push('engine');};
  try{const ticking=f.handler.tick();assert.deepEqual(order,['admission','engine','cleanup']);await ticking;}
  finally{f.game.tick=original;f.game.afterRound=originalAfter;}
});

test('non-authoritative post-round rejection remains a reported failure after waiting for the engine',async()=>{
  const f=await fixture(),original=f.game.tick,originalAfter=f.game.afterRound;let calls=0;
  f.game.tick=async()=>{await Promise.resolve();f.table.completed=true;};f.game.afterRound=()=>{if(++calls===1)return;assert.equal(f.table.completed,true);return Promise.reject(Error('local cleanup failed'));};
  try{const result=await f.handler.tick();assert.equal(result.length,1);assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/local cleanup failed/);}
  finally{f.game.tick=original;f.game.afterRound=originalAfter;}
});

test('an old asynchronous tick cannot clean up or delete a replacement room registered under the same identity',async()=>{
  const f=await fixture(),original=f.game.tick,originalAfter=f.game.afterRound;let release,started,cleanups=0;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  f.game.tick=async()=>{started();await gate;f.table.retired=true;};let calls=0;f.game.afterRound=()=>{if(++calls>1)cleanups++;};
  try{
    const ticking=f.handler.tick();await entered;const replacement={...f.table,retired:false,replacement:true};f.runtime.registry.setTable(f.table.roomId,replacement,7,f.game.id);
    release();await ticking;assert.equal(f.runtime.registry.getTable(f.table.roomId,7,f.game.id),replacement,'old completion deleted a newly registered room');assert.equal(cleanups,0,'old tick entered followup cleanup after room replacement');
  }finally{release();f.game.tick=original;f.game.afterRound=originalAfter;}
});

test('an asynchronous tick finishing after registry removal does not call post-round cleanup or recreate the room',async()=>{
  const f=await fixture(),original=f.game.tick,originalAfter=f.game.afterRound;let release,started,cleanups=0;
  const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});f.game.tick=async()=>{started();await gate;};let calls=0;f.game.afterRound=()=>{if(++calls>1)cleanups++;};
  try{const ticking=f.handler.tick();await entered;f.runtime.registry.removeTable(f.table.roomId,7,f.game.id);release();await ticking;assert.equal(cleanups,0);assert.equal(f.runtime.registry.getTable(f.table.roomId,7,f.game.id),null);}
  finally{release();f.game.tick=original;f.game.afterRound=originalAfter;}
});
