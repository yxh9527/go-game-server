import test from 'node:test';
import assert from 'node:assert/strict';
import {importHotModule} from '../../../shared/hot-import.js';
const {BairenGame}=await importHotModule(new URL('../../../game-server/src/core/BairenGame.js',import.meta.url).href,'hundred-async-cycle');
const {HundredGame}=await importHotModule(new URL('../../../game-server/src/core/HundredGame.js',import.meta.url).href,'hundred-async-cycle');

function fixture(kind){
  const order=[],config={id:'async-hundred',kind:'hundred',roomTypes:[50],tickCycle:8},engine={PHASE:{IDLE:0},tick(){}};
  const game=kind==='bairen'?new BairenGame(config,engine,()=>({playMode:0,betAreaOdds:{1:1}})):new HundredGame(config);
  const table=game.createTable(700001,50,{room_type:50}),ctx={table,io:{broadcast(){}},runtime:{}};
  game.tickRobots=()=>order.push('robots');game.pushState=()=>order.push('state');return {order,game,table,ctx,engine};
}

for(const kind of ['bairen','legacy'])test(kind+': pending engine cycles gate robot scheduling and repeated room ticks',async()=>{
  const f=fixture(kind);let release;const gate=new Promise(resolve=>{release=resolve;});
  const cycle=async()=>{f.order.push('start');await gate;f.table.cycleDone=true;f.order.push('done');return 42;};
  if(kind==='bairen')f.engine.tick=cycle;else f.game.onCycle=cycle;
  f.game.tickRobots=()=>{assert.equal(f.table.cycleDone,true);f.order.push('robots');};
  const first=f.game.tick(f.ctx);assert.ok(first&&typeof first.then==='function');assert.deepEqual(f.order,['start']);
  const second=f.game.tick(f.ctx);assert.equal(second,first);assert.deepEqual(f.order,['start']);if(kind==='legacy')assert.equal(f.table.tick,1);
  release();await first;assert.deepEqual(f.order,kind==='bairen'?['start','done','robots']:['start','done','robots','state']);assert.equal(f.table.hundredCycleTask,null);
});

for(const kind of ['bairen','legacy'])test(kind+': failed cycles skip robot/state success followups and release the room task',async()=>{
  const f=fixture(kind),cycle=async()=>{await Promise.resolve();throw Error('cycle failed');};
  if(kind==='bairen')f.engine.tick=cycle;else f.game.onCycle=cycle;
  await assert.rejects(f.game.tick(f.ctx),/cycle failed/);assert.deepEqual(f.order,[]);assert.equal(f.table.hundredCycleTask,null);
  if(kind==='bairen')f.engine.tick=()=>{f.order.push('engine');};else f.game.onCycle=()=>{f.order.push('engine');};
  assert.equal(f.game.tick(f.ctx),undefined);assert.deepEqual(f.order,kind==='bairen'?['engine','robots']:['engine','robots','state']);
});

for(const kind of ['bairen','legacy'])test(kind+': synchronous cycle order and errors remain synchronous',()=>{
  const f=fixture(kind),cycle=()=>{f.order.push('engine');};if(kind==='bairen')f.engine.tick=cycle;else f.game.onCycle=cycle;
  assert.equal(f.game.tick(f.ctx),undefined);assert.deepEqual(f.order,kind==='bairen'?['engine','robots']:['engine','robots','state']);
  const failed=()=>{throw Error('sync cycle failed');};if(kind==='bairen')f.engine.tick=failed;else f.game.onCycle=failed;
  f.order.length=0;assert.throws(()=>f.game.tick(f.ctx),/sync cycle failed/);assert.deepEqual(f.order,[]);
});

for(const kind of ['bairen','legacy'])test(kind+': a replacement game instance reuses the old pending room cycle',async()=>{
  const f=fixture(kind),next=fixture(kind);let release;const gate=new Promise(resolve=>{release=resolve;});
  const cycle=async()=>{f.order.push('old engine');await gate;};if(kind==='bairen')f.engine.tick=cycle;else f.game.onCycle=cycle;
  const original=f.game.tick(f.ctx);const shared=next.game.tick(f.ctx);assert.equal(shared,original);assert.deepEqual(next.order,[]);
  release();await shared;assert.equal(f.table.hundredCycleTask,null);assert.deepEqual(f.order,kind==='bairen'?['old engine','robots']:['old engine','robots','state']);assert.deepEqual(next.order,[]);
  next.game.tick(f.ctx);assert.deepEqual(next.order,kind==='bairen'?['robots']:['robots','state']);
});

test('asynchronous beforeTick completes before the legacy cycle and repeated ticks reuse the wait',async()=>{
  const f=fixture('legacy');let release,preparations=0;const gate=new Promise(resolve=>{release=resolve;});
  f.game.beforeTick=async()=>{preparations++;f.order.push('prepare');await gate;f.table.prepared=true;f.order.push('ready');};
  f.game.onCycle=()=>{assert.equal(f.table.prepared,true);f.order.push('cycle');};
  const pending=f.game.tick(f.ctx);assert.ok(pending&&typeof pending.then==='function');assert.deepEqual(f.order,['prepare']);assert.equal(f.game.tick(f.ctx),pending);assert.equal(preparations,1);
  release();await pending;assert.deepEqual(f.order,['prepare','ready','cycle','robots','state']);assert.equal(f.table.hundredCycleTask,null);
});

test('beforeTick rejection skips every cycle followup and allows the next ordinary synchronous tick',async()=>{
  const f=fixture('legacy');f.game.beforeTick=async()=>{throw Error('preparation failed');};f.game.onCycle=()=>f.order.push('cycle');
  await assert.rejects(f.game.tick(f.ctx),/preparation failed/);assert.deepEqual(f.order,[]);assert.equal(f.table.tick,0);assert.equal(f.table.hundredCycleTask,null);
  f.game.beforeTick=()=>f.order.push('ready');assert.equal(f.game.tick(f.ctx),undefined);assert.deepEqual(f.order,['ready','cycle','robots','state']);
});

test('timed cycle does not re-run beforeTick while its original transition is awaiting completion',async()=>{
  const f=fixture('legacy');f.game.config={...f.game.config,timedPhases:[{state:2,cycle:1,seconds:1},{state:4,cycle:2,seconds:1}]};f.table.hundredPhaseIndex=0;f.table.phaseEndsAt=0;
  let release,preparations=0;const gate=new Promise(resolve=>{release=resolve;});f.game.beforeTick=()=>{preparations++;};f.game.onCycle=()=>gate;
  const pending=f.game.tick(f.ctx);assert.equal(f.game.tick(f.ctx),pending);assert.equal(preparations,1);assert.deepEqual(f.order,[]);release();await pending;assert.deepEqual(f.order,['state','robots']);assert.equal(f.table.hundredCycleTask,null);
});

test('asynchronous preparation and cycle remain one awaited chain while a replacement instance reuses pending work',async()=>{
  const f=fixture('legacy'),next=fixture('legacy');let prepare,cycle;
  const prep=new Promise(resolve=>{prepare=resolve;}),work=new Promise(resolve=>{cycle=resolve;});f.game.beforeTick=()=>prep;f.game.onCycle=()=>{f.order.push('cycle');return work;};
  const pending=f.game.tick(f.ctx);assert.equal(next.game.tick(f.ctx),pending);prepare();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(f.order,['cycle']);
  const following=next.game.tick(f.ctx);assert.ok(following&&typeof following.then==='function');assert.deepEqual(next.order,[]);cycle();await pending;await following;assert.deepEqual(f.order,['cycle','robots','state']);assert.equal(f.table.hundredCycleTask,null);
});

test('finishing an old timed cycle does not erase a different task currently installed on the room',async()=>{
  const f=fixture('legacy');f.game.config={...f.game.config,timedPhases:[{state:2,cycle:1,seconds:1},{state:4,cycle:2,seconds:1}]};f.table.hundredPhaseIndex=0;f.table.phaseEndsAt=0;
  let release;const gate=new Promise(resolve=>{release=resolve;});f.game.onCycle=()=>gate;
  const original=f.game.tick(f.ctx),newer=new Promise(()=>{});f.table.hundredCycleTask=newer;release();await original;assert.equal(f.table.hundredCycleTask,newer);
});

test('a room retired or closed without an active hand during preparation cannot advance a new cycle',async()=>{
  for(const change of [table=>{table.retired=true;},table=>{table.closing=true;}]){
    const f=fixture('legacy');let release;const gate=new Promise(resolve=>{release=resolve;});f.game.beforeTick=()=>gate;f.game.onCycle=()=>f.order.push('cycle');
    const pending=f.game.tick(f.ctx);change(f.table);release();await pending;assert.deepEqual(f.order,[]);assert.equal(f.table.tick,0);assert.equal(f.table.hundredCycleTask,null);
  }
});

test('async preparation cannot advance an original room that was removed or replaced in its registry',async()=>{
  for(const replaced of [false,true]){
    const f=fixture('legacy');let current=f.table,release;f.ctx.runtime.registry={getTable:()=>current};const gate=new Promise(resolve=>{release=resolve;});f.game.beforeTick=()=>gate;f.game.onCycle=()=>f.order.push('cycle');
    const pending=f.game.tick(f.ctx);const replacement={...f.table,replacement:true};current=replaced?replacement:null;release();await pending;assert.deepEqual(f.order,[]);assert.equal(current,replaced?replacement:null);assert.equal(f.table.hundredCycleTask,null);
  }
});

test('closing a room with a funded active hand still permits its existing cycle to finish',async()=>{
  const f=fixture('legacy');f.table.closing=true;f.table.hand={settled:false};f.game.onCycle=()=>f.order.push('existing hand');
  f.game.tick(f.ctx);assert.deepEqual(f.order,['existing hand','robots','state']);
});
