import test from 'node:test';
import assert from 'node:assert/strict';
import {createSmartBet} from '../../../game-server/src/core/smart-bet.js';
import {createRegistry} from '../../../game-server/src/registry.js';
import {BaccaratGame} from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import {createAuthoritativeWallet} from '../../../game-server/src/wallet/authoritative.js';
import {seatFinanceAuthority} from '../../fixtures/seat-finance-authority.js';
import {createRoundFinance} from '../../../game-server/src/wallet/round-finance.js';
import {createGameRouteIndex} from '../../../shared/rpc/game-routes.js';
import {installUserCenter} from '../../../game-server/src/core/user-center.js';

function storage(){
 const tasks=new Map();let readsUnavailable=false;
 const call=async(action,input)=>{
  if(action==='save'){
   const old=tasks.get(input.task.taskId),next=structuredClone(input.task);
   if(old?.control)next.control=structuredClone(old.control);
   if(!old||next.version>=old.version)tasks.set(next.taskId,next);
   return {stored:true,task:structuredClone(tasks.get(next.taskId))};
  }
  if(action==='list')return [...tasks.values()].filter(t=>t.agentId===input.agentId&&t.userId===input.userId&&t.roomType===input.roomType&&!t.deleted).map(t=>structuredClone(t));
  if(action==='readMany'){
   if(readsUnavailable)throw Error('storage unavailable');
   return input.taskIds.map(id=>tasks.get(id)).filter(t=>t?.instanceId===input.instanceId).map(t=>structuredClone(t));
  }
  if(action==='begin'){
   const task=tasks.get(input.taskId);
   if(!task||task.instanceId!==input.instanceId||task.version!==input.expectedVersion||task.status!=='running'||task.activeAttempt||task.control?.stopRequested)throw Error('execution registration rejected');
   task.activeAttempt=structuredClone(input.attempt);task.version++;
   return {task:structuredClone(task)};
  }
  if(action==='resolve'){
   const task=tasks.get(input.taskId);
   if(!task||task.agentId!==input.agentId||task.userId!==input.userId||task.roomType!==input.roomType)throw Error('没有该任务');
   if(task.activeAttempt&&!task.confirmedNet)throw Error('原金融结果尚未确认');
   if(task.activeAttempt){task.profit+=task.confirmedNet;task.completedCount++;task.lastSettledInning=task.activeAttempt.inning}
   task.status='stopped';task.stopping=true;task.resolvedAt=Date.now();task.version++;delete task.activeAttempt;delete task.pendingInning;
   return {task:structuredClone(task)};
  }
  if(action==='control'){
   const task=tasks.get(input.taskId);
   if(!task||task.agentId!==input.agentId||task.userId!==input.userId||task.roomType!==input.roomType)throw Object.assign(Error('没有该任务'),{status:404});
   if(input.action==='delete'){
    if(task.status!=='stopped'||task.pendingInning||task.activeAttempt)throw Object.assign(Error('等待结算'),{status:409});
    task.deleted=true;task.version++;
   }else if(task.status!=='stopped'&&!task.control?.stopRequested)task.control={stopRequested:true,revision:1};
   return {task:structuredClone(task)};
  }
  throw Error('unsupported storage action '+action);
 };
 return {tasks,call,failReads:value=>readsUnavailable=value};
}

async function fixture(shared=storage()){
 const game=new BaccaratGame(),table=game.createTable(58010000,58,{game_type:1002,room_type:58,game_room_config_id:5801,finance_level:1});table.agentId=7;table.state=2;table.phaseEndsAt=Date.now()+60000;table.inning=1;
 const registry=createRegistry(),authority=seatFinanceAuthority(),wallet=createAuthoritativeWallet({common:authority.common}),runtime={env:'prod',wallet,registry,log:{error(){}},gateway:{smartTask:async()=>({stored:true})}};
 registry.setTable(table.roomId,table,7,game.id);wallet.configureLottery(createRoundFinance(authority.common,{routes:createGameRouteIndex([{gameType:1002,roomType:58,number:92058,symbol:'smart-baccarat',state:1,isFrozen:0}])}),[58],runtime);
 authority.add(42);const session={userId:42,agentId:7,currency:'CNY',authenticated:true,inRoom:true,hundredInRoom:true,hundredRoomIds:new Set([table.roomId]),roomId:table.roomId,gameId:game.id};registry.bind({},session);await wallet.load(session);
 installUserCenter(runtime);
 const io={wallet,env:'prod',broadcast(){},sendUser(){},sessionFor:()=>session,forEachPlayer:fn=>fn(session)},smart=createSmartBet(runtime,()=>game,()=>io);
 runtime.gateway.smartTask=shared.call;
 return {smart,table,runtime,session,authority,wallet,storage:shared,game,io,user:{userId:42,agentId:7,currency:'CNY'},request:{action:'create',strategy:'FIXED',roomType:58,roomId:table.roomId,areaId:1,betAmount:100,stopCountLimit:2,requestId:'fixed-one'}};
}
test('fixed tasks place one real unified wager per inning, enforce limits, and stop after settlement without cancelling accepted bets',async()=>{
 const f=await fixture(),created=await f.smart.command(f.user,{...f.request,takeProfit:100});
 assert.equal(created.code,0);assert.equal(f.authority.calls.length,0,'task creation must not charge a wager');
 assert.equal((await f.smart.command(f.user,{...f.request,takeProfit:100})).taskId,created.taskId);
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
 assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,1);assert.equal(f.session.wallet,99900);
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,1);
 await assert.rejects(()=>f.smart.command({userId:43,agentId:7},{action:'stop',roomType:58,taskId:created.taskId}),/没有该任务/);
 await f.smart.command(f.user,{action:'stop',roomType:58,taskId:created.taskId});
 await assert.rejects(()=>f.smart.command(f.user,{action:'delete',roomType:58,taskId:created.taskId}),/结算/);
 f.table.recordUserCenter([{uid:42,score:100}],{inning:1});await f.smart.flush();
 const task=(await f.smart.command(f.user,{action:'list',roomType:58})).myTasks[0];assert.equal(task.status,'stopped');assert.equal(task.profit,100);assert.equal(task.completedCount,1);
 await f.smart.command(f.user,{action:'delete',roomType:58,taskId:created.taskId});assert.equal((await f.smart.command(f.user,{action:'list',roomType:58})).myTasks.length,0);
});

test('another game instance queries and stops the owner task without marking it interrupted or placing a second wager',async()=>{
 const shared=storage(),owner=await fixture(shared),other=await fixture(shared);
 const created=await owner.smart.command(owner.user,owner.request);
 const remote=(await other.smart.command(other.user,{action:'list',roomType:58})).myTasks[0];
 assert.equal(remote.status,'running');assert.equal(remote.executionLocal,false);assert.equal(remote.stopReason,undefined);
 await assert.rejects(()=>other.smart.command(other.user,{...other.request,requestId:'another-task'}),/未完成任务/);
 assert.equal((await other.smart.command(other.user,{action:'detail',roomType:58,taskId:created.taskId})).taskDetail.taskId,created.taskId);
 const response=await other.smart.command(other.user,{action:'stop',roomType:58,taskId:created.taskId});assert.equal(response.taskDetail.status,'stopping');
 await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,0);
 const stopped=(await other.smart.command(other.user,{action:'list',roomType:58})).myTasks[0];assert.equal(stopped.status,'stopped');
 await other.smart.command(other.user,{action:'delete',roomType:58,taskId:created.taskId});
 assert.equal((await owner.smart.command(owner.user,{action:'list',roomType:58})).myTasks.length,0,'deleted remote records must not return from local memory');
 assert.equal(owner.runtime.smartBetState.tasks.size,0,'remote deletion releases the stopped local task');
 assert.equal(owner.table.smartTasks.size,0);
 assert.equal(other.authority.calls.length,0);
});

test('hot reload preserves owner identity and does not repeat the accepted wager while remote stop is pending',async()=>{
 const shared=storage(),owner=await fixture(shared),other=await fixture(shared);
 const created=await owner.smart.command(owner.user,owner.request),instance=owner.runtime.smartBetState.instance;
 await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 const {createSmartBet:reload}=await import('../../../game-server/src/core/smart-bet.js?v=multi-instance-reload');
 owner.smart=reload(owner.runtime,()=>new BaccaratGame(),()=>({wallet:owner.wallet,broadcast(){},sendUser(){}}));
 assert.equal(owner.runtime.smartBetState.instance,instance);
 await other.smart.command(other.user,{action:'stop',roomType:58,taskId:created.taskId});
 owner.table.smartControlRead=null;
 await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 owner.table.recordUserCenter([{uid:42,score:0}],{inning:1});await owner.smart.flush();
 const task=(await other.smart.command(other.user,{action:'list',roomType:58})).myTasks[0];
 assert.equal(task.status,'stopped');assert.equal(task.completedCount,1);assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,1);
});

test('repeated controller replacement does not accumulate room hooks or overflow the call stack',()=>{
 let records=0;const table={roomType:58,recordUserCenter(){records++}},registry={tables:new Map(),setTable(id,value){this.tables.set(id,value);return value}};
 registry.setTable(1,table);
 const runtime={env:'dev',registry,log:{error(){}}};
 for(let count=0;count<12000;count++)createSmartBet(runtime,()=>({}),()=>({}));
 assert.doesNotThrow(()=>registry.setTable(2,{roomType:58}));
 assert.doesNotThrow(()=>table.recordUserCenter([],{inning:1}));assert.equal(records,1);
});

test('remote stop waits for the already accepted wager and control outage blocks new wagers',async()=>{
 const shared=storage(),owner=await fixture(shared),other=await fixture(shared);let now=Date.now();owner.runtime.clock=()=>now;
 const created=await owner.smart.command(owner.user,owner.request);
 shared.failReads(true);await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);
 assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,0);
 shared.failReads(false);now+=1001;await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,1);
 await other.smart.command(other.user,{action:'stop',roomType:58,taskId:created.taskId});
 await assert.rejects(()=>other.smart.command(other.user,{action:'delete',roomType:58,taskId:created.taskId}),/结算/);
 now+=1001;await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 assert.equal((await other.smart.command(other.user,{action:'list',roomType:58})).myTasks[0].status,'stopping');
 owner.table.recordUserCenter([{uid:42,score:-100}],{inning:1});await owner.smart.flush();
 const task=(await other.smart.command(other.user,{action:'list',roomType:58})).myTasks[0];assert.equal(task.status,'stopped');assert.equal(task.profit,-100);assert.equal(task.completedCount,1);
 owner.table.inning=2;await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,1);
});
test('automatic take-profit and stop-loss use settled net and stop future rounds',async()=>{
 for(const score of [100,-100]){
  const f=await fixture();await f.smart.command(f.user,{...f.request,takeProfit:100,stopLoss:100});
  await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
  f.table.recordUserCenter([{uid:42,score}],{inning:1});await f.smart.flush();
  const task=(await f.smart.command(f.user,{action:'list',roomType:58})).myTasks[0];assert.equal(task.status,'stopped');assert.equal(task.stopReason,score>0?'TAKE_PROFIT':'STOP_LOSS');
  f.table.inning=2;await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,1);
 }
});

test('wager is not submitted until its exact round execution registration is durably confirmed',async()=>{
 const f=await fixture(),created=await f.smart.command(f.user,f.request),invoke=f.runtime.gateway.smartTask;
 f.runtime.gateway.smartTask=async(action,input)=>{
  if(action==='begin')throw Error('registration unavailable');return invoke(action,input);
 };
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,0);
 f.runtime.gateway.smartTask=invoke;await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
 const task=f.storage.tasks.get(created.taskId),bet=f.authority.calls.find(c=>c.method==='bet');
 assert.ok(task.activeAttempt);assert.equal(task.activeAttempt.roundId,bet.request.roundId);assert.equal(task.activeAttempt.gameId,bet.request.gameId);assert.equal(task.pendingInning,1);
 assert.equal(task.activeAttempt.areaId,f.request.areaId);
 assert.equal(bet.request.items[0].areaId,'smart:'+task.activeAttempt.attemptId+':'+f.request.areaId);
 assert.deepEqual(f.table.playerBets.get(f.user.userId),[{areaId:f.request.areaId,total:f.request.betAmount}],'public room bets retain numeric game areas');
});

test('lost execution-registration reply retains durable responsibility without replaying or submitting money',async()=>{
 const f=await fixture(),created=await f.smart.command(f.user,f.request),invoke=f.runtime.gateway.smartTask;
 f.runtime.gateway.smartTask=async(action,input)=>{const response=await invoke(action,input);if(action==='begin')throw Error('ack lost');return response};
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);
 assert.ok(f.storage.tasks.get(created.taskId).activeAttempt);assert.equal(f.authority.calls.length,0);
 f.runtime.gateway.smartTask=invoke;f.table.smartControlRead=null;
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);assert.equal(f.authority.calls.length,0,'uncertain execution intent must not be submitted as a new wager');
});

test('another instance can finish a confirmed result; the original instance adopts it without another wager',async()=>{
 const shared=storage(),owner=await fixture(shared),other=await fixture(shared);
 const created=await owner.smart.command(owner.user,owner.request);
 await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);await owner.smart.flush();
 await assert.rejects(()=>other.smart.command(other.user,{action:'resolve',roomType:58,taskId:created.taskId}),/尚未确认/);
 shared.tasks.get(created.taskId).confirmedNet=100;
 const result=await other.smart.command(other.user,{action:'resolve',roomType:58,taskId:created.taskId});assert.equal(result.taskDetail.status,'stopped');assert.equal(result.taskDetail.completedCount,1);
 owner.table.smartControlRead=null;owner.table.inning=2;
 await owner.wallet.run(()=>owner.smart.tick(owner.table),owner.runtime);
 assert.equal(owner.runtime.smartBetState.tasks.get(created.taskId).status,'stopped');assert.equal(owner.authority.calls.filter(c=>c.method==='bet').length,1);
});

test('actual card settlement binds the original task attempt into its durable final financial report',async()=>{
 const f=await fixture();await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,0),f.runtime);
 f.table.state=2;f.table.phaseEndsAt=Date.now()+60000;
 const created=await f.smart.command(f.user,f.request);
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
 const attempt=structuredClone(f.storage.tasks.get(created.taskId).activeAttempt);
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,3),f.runtime);
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,4),f.runtime);
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,6),f.runtime);await f.smart.flush();
 const settlement=f.authority.calls.find(c=>c.method==='settlement');assert.ok(settlement);
 const report=JSON.parse(settlement.request.items.find(i=>i.userId===42).record).completedDisplayReport;
 assert.deepEqual(report.smartTask,{taskId:created.taskId,attemptId:attempt.attemptId,inning:attempt.inning});
 assert.equal(settlement.request.roundId,attempt.roundId);
 assert.equal(f.storage.tasks.get(created.taskId).activeAttempt,undefined);assert.equal(f.storage.tasks.get(created.taskId).completedCount,1);
});

test('smart betting advances from the actual game settlement even when ES report writing fails',async()=>{
 const f=await fixture(),errors=[];let reportAttempts=0;
 f.runtime.log.error=(...args)=>errors.push(args);
 f.runtime.gateway.writeUserCenter=async()=>{reportAttempts++;throw Error('ES unavailable')};
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,0),f.runtime);
 f.table.state=2;f.table.phaseEndsAt=Date.now()+60000;
 const created=await f.smart.command(f.user,f.request);
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,3),f.runtime);
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,4),f.runtime);
 await f.wallet.run(()=>f.game.engine.applyCycle(f.io,f.table,6),f.runtime);
 await f.runtime.userCenterState.writeTask;await f.smart.flush();
 const settlement=f.authority.calls.find(c=>c.method==='settlement');assert.ok(settlement);
 const gameResult=JSON.parse(settlement.request.items.find(item=>item.userId===42).record).completedDisplayReport;
 const task=f.storage.tasks.get(created.taskId);
 assert.equal(task.completedCount,1);assert.equal(task.profit,gameResult.net);assert.equal(task.totalBetAmount,100);
 assert.equal(task.pendingInning,undefined);assert.equal(task.activeAttempt,undefined);
 assert.equal(reportAttempts,1);assert.equal(f.runtime.userCenterState.outgoing.size,0);
 assert.ok(errors.some(args=>String(args[0]).includes('ES write failed; no retry')));
 assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,1);
});

async function stopBeforeWager(f){
 const created=await f.smart.command(f.user,f.request);
 await f.smart.command(f.user,{action:'stop',roomType:58,taskId:created.taskId});
 f.table.smartControlRead=null;
 await f.wallet.run(()=>f.smart.tick(f.table),f.runtime);await f.smart.flush();
 assert.equal(f.storage.tasks.get(created.taskId).status,'stopped');
 assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,0);
 return created.taskId;
}

test('confirmed stopped tasks leave local maps after one hour while SQL history and original creation retries remain intact',async t=>{
 let now=Date.UTC(2026,10,13,1);t.mock.method(Date,'now',()=>now);
 const f=await fixture(),id=await stopBeforeWager(f),at=f.runtime.smartBetState.retired.get(id).at;
 now=at+3599000;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.size,1);
 await f.smart.command(f.user,{action:'list',roomType:58});
 assert.equal(f.runtime.smartBetState.retired.get(id).at,at,'history reads cannot renew retention');
 now=at+3605000;await f.smart.flush();
 assert.equal(f.runtime.smartBetState.tasks.size,0);assert.equal(f.table.smartTasks.size,0);assert.equal(f.runtime.smartBetState.retired.size,0);
 assert.equal(f.storage.tasks.size,1,'local pruning must not delete SQL history');
 const history=await f.smart.command(f.user,{action:'list',roomType:58});assert.equal(history.myTasks[0].taskId,id);
 const retried=await f.smart.command(f.user,f.request);assert.equal(retried.taskDetail.status,'stopped');
 assert.equal(f.runtime.smartBetState.tasks.size,0,'an old request cannot reactivate a pruned task');
 await assert.rejects(()=>f.smart.command(f.user,{...f.request,betAmount:200}),{status:409});
 await f.smart.command(f.user,{...f.request,requestId:'new-task'});assert.equal(f.runtime.smartBetState.tasks.size,1);
 assert.equal(f.authority.calls.filter(c=>c.method==='bet').length,0);
});

test('stopped task retention survives hot replacement and repeated confirmations never renew the original time',async t=>{
 let now=Date.UTC(2026,10,13,1);t.mock.method(Date,'now',()=>now);
 const f=await fixture(),id=await stopBeforeWager(f),at=f.runtime.smartBetState.retired.get(id).at;
 now+=1000;
 f.runtime.smartBetState.pending.set(id,structuredClone(f.runtime.smartBetState.tasks.get(id)));await f.smart.flush();
 assert.equal(f.runtime.smartBetState.retired.get(id).at,at);
 const {createSmartBet:reload}=await import('../../../game-server/src/core/smart-bet.js?v=stopped-retention');
 f.smart=reload(f.runtime,()=>f.game,()=>f.io);
 assert.equal(f.runtime.smartBetState.retired.get(id).at,at);
 now=at+3605000;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.size,0);assert.equal(f.table.smartTasks.size,0);
});

test('pending money, active attempts and unconfirmed stopped snapshots are never removed by memory cleanup',async t=>{
 let now=Date.UTC(2026,10,13,1);t.mock.method(Date,'now',()=>now);
 const f=await fixture(),id=await stopBeforeWager(f),task=f.runtime.smartBetState.tasks.get(id);
 task.activeAttempt={roundId:'unconfirmed-original',attemptId:'still-open'};
 now+=7200000;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.get(id),task);
 assert.equal(f.runtime.smartBetState.retired.has(id),false,'a changed liability invalidates the terminal receipt');
 delete task.activeAttempt;
 f.runtime.smartBetState.retired.set(id,{at:now-7200000,version:task.version});
 f.runtime.smartBetState.pending.set(id,structuredClone(task));
 const invoke=f.runtime.gateway.smartTask;
 f.runtime.gateway.smartTask=async(action,input)=>{if(action==='save')throw Error('SQL unavailable');return invoke(action,input)};
 now+=5001;await f.smart.flush();
 assert.equal(f.runtime.smartBetState.tasks.get(id),task);assert.equal(f.runtime.smartBetState.pending.size,1);
 f.runtime.gateway.smartTask=invoke;await f.smart.flush();now+=5001;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.size,0);
});

test('incomplete or mismatched task persistence receipts retain queued terminal data',async()=>{
 for(const variant of ['missing','wrong-task','wrong-version','wrong-status']){
  const f=await fixture(),id=(await f.smart.command(f.user,f.request)).taskId,task=f.runtime.smartBetState.tasks.get(id);
  Object.assign(task,{status:'stopped',stopping:true,version:task.version+1});
  f.runtime.smartBetState.pending.set(id,structuredClone(task));
  f.runtime.gateway.smartTask=async(action,input)=>{
   assert.equal(action,'save');const saved=structuredClone(input.task);
   if(variant==='missing')return {stored:true};
   if(variant==='wrong-task')saved.taskId='another';
   if(variant==='wrong-version')saved.version++;
   if(variant==='wrong-status')saved.status='running';
   return {stored:true,task:saved};
  };
  await f.smart.flush();assert.equal(f.runtime.smartBetState.pending.size,1);assert.equal(f.runtime.smartBetState.retired.size,0);
 }
});

test('a stale save acknowledgement cannot retire newer local financial responsibility',async()=>{
 const f=await fixture(),id=(await f.smart.command(f.user,f.request)).taskId,task=f.runtime.smartBetState.tasks.get(id);
 Object.assign(task,{status:'stopped',version:task.version+1});
 const snapshot=structuredClone(task);f.runtime.smartBetState.pending.set(id,snapshot);
 let release;const held=new Promise(resolve=>{release=resolve});
 f.runtime.gateway.smartTask=async()=>{await held;return {stored:true,task:snapshot}};
 const pending=f.smart.flush();
 task.version++;task.activeAttempt={roundId:'original',attemptId:'open'};
 f.runtime.smartBetState.pending.set(id,structuredClone(task));
 release();await pending;
 assert.equal(f.runtime.smartBetState.tasks.get(id),task);assert.equal(f.runtime.smartBetState.retired.size,0);assert.equal(f.runtime.smartBetState.pending.size,1);
});

test('hot upgrade reconfirms legacy stopped records before expiry and pruning is bounded to one hundred per pass',async t=>{
 let now=Date.UTC(2026,10,13,1);t.mock.method(Date,'now',()=>now);
 const f=await fixture(),base={...(await f.smart.command(f.user,f.request)).taskDetail,status:'stopped',version:2};
 delete base.executionLocal;
 f.runtime.smartBetState.tasks.clear();f.table.smartTasks.clear();delete f.runtime.smartBetState.retentionInitialized;
 for(let i=0;i<105;i++){
  const task={...base,taskId:`7:42:finished-${i}`};f.runtime.smartBetState.tasks.set(task.taskId,task);f.table.smartTasks.set(task.taskId,task);
 }
 f.smart=createSmartBet(f.runtime,()=>f.game,()=>f.io);assert.equal(f.runtime.smartBetState.pending.size,105);
 await f.smart.flush();assert.equal(f.runtime.smartBetState.pending.size,5);assert.equal(f.runtime.smartBetState.retired.size,100);
 await f.smart.flush();assert.equal(f.runtime.smartBetState.pending.size,0);assert.equal(f.runtime.smartBetState.retired.size,105);
 now+=3605000;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.size,5);
 now+=5001;await f.smart.flush();assert.equal(f.runtime.smartBetState.tasks.size,0);assert.equal(f.table.smartTasks.size,0);
});

