import {randomUUID} from 'node:crypto';
import {financeRound} from './hundred-finance.js';

const fail=(status,message)=>Object.assign(new Error(message),{status});
const safe=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const tableHook=Symbol.for('gogame.smart-bet.table-hook');
const recordHook=Symbol.for('gogame.smart-bet.record-hook');
const stoppedRetentionMs=3600000;

export function createSmartBet(runtime,gameOf,ioOf){
 const resident=runtime.smartBetState||={instance:randomUUID(),tasks:new Map(),pending:new Map()};
 resident.retired||=new Map();
 const persist=async task=>{
  if(runtime.env!=='prod')return;
  const receipt=await (runtime.gateway||runtime.rpc?.gateway).smartTask('save',{task});
  if(receipt?.stored!==true||!receipt.task||!sameTask(task,receipt.task)||receipt.task.version!==task.version||receipt.task.status!==task.status)
    throw fail(503,'任务持久化回执未确认');
  confirmRetired(receipt.task);
  return receipt;
 };
 const own=(task,user)=>task.agentId===user.agentId&&task.userId===user.userId;
 const sameTask=(a,b)=>['taskId','agentId','userId','roomType','roomId','instanceId','areaId','betAmount','stopCountLimit','takeProfit','stopLoss','currency','strategy'].every(key=>a[key]===b[key]);
 const terminal=task=>task?.status==='stopped'&&!task.pendingInning&&!task.activeAttempt;
 function confirmRetired(task){
  if(runtime.env!=='prod'||!terminal(task))return;
  const current=resident.tasks.get(task.taskId);
  if(!current||!terminal(current)||current.version!==task.version||!sameTask(current,task))return;
  const original=resident.retired.get(task.taskId);
  resident.retired.set(task.taskId,{at:original?.at??Date.now(),version:task.version});
 }
 function forgetLocal(id,task){
  if(resident.tasks.get(id)!==task)return;
  resident.tasks.delete(id);resident.retired.delete(id);
  for(const table of runtime.registry.tables.values())if(table.smartTasks?.get(id)===task)table.smartTasks.delete(id);
 }
 function prune(){
  if(runtime.env!=='prod')return;
  const now=Date.now();
  if(resident.prunedAt!=null&&now>=resident.prunedAt&&now-resident.prunedAt<5000)return;
  resident.prunedAt=now;let removed=0;
  for(const [id,receipt]of resident.retired){
   const task=resident.tasks.get(id);
   if(!task){resident.retired.delete(id);continue}
   if(!terminal(task)){resident.retired.delete(id);continue}
   if(task.version!==receipt.version||resident.pending.has(id)||now-receipt.at<stoppedRetentionMs)continue;
   forgetLocal(id,task);if(++removed>=100)break;
  }
 }
 function project(task){return {...structuredClone(task),executionLocal:task.instanceId===resident.instance,
   ...(task.status==='running'&&(task.stopping||task.control?.stopRequested)?{status:'stopping'}:{})};}
 function applyControl(task,control){
  if(!control||!Number.isSafeInteger(control.revision)||control.revision<Number(task.control?.revision||0))return false;
  task.control=structuredClone(control);
  if(control.stopRequested&&!task.stopping){stop(task,'USER_STOP');return true}
  return false;
 }
 function stop(task,reason){task.stopping=true;task.stopReason=reason;if(!task.pendingInning)task.status='stopped';task.version++;}
 const afterCommit=work=>runtime.wallet?.deliver?runtime.wallet.deliver(work):work();
 function writeLater(task){
  afterCommit(()=>{
   const snapshot=structuredClone(task);resident.pending.set(task.taskId,snapshot);void flush();
  });
 }
 async function flush(){
  prune();
  if(resident.writeTask)return resident.writeTask;
  const task=(async()=>{let written=0;for(const [id,snapshot]of resident.pending){try{await persist(snapshot);if(resident.pending.get(id)===snapshot)resident.pending.delete(id);if(++written>=100)break}catch(error){runtime.log.error('smart task persistence pending',id,error.message);break}}})();
  resident.writeTask=task;try{await task}finally{resident.writeTask=null}
 }
 function install(table){
  if(![58,59].includes(Number(table.roomType)))return;
  table.smartTasks||=new Map();
  const current=table.recordUserCenter;
  const original=current&&Object.hasOwn(current,recordHook)?current[recordHook]:current;
  const record=(results,extra)=>{
   original?.(results,extra);
   const inning=Number(extra?.inning??table.inning);
   for(const task of table.smartTasks.values())if(task.pendingInning===inning){
    const result=results.find(r=>Number(r.uid)===task.userId);if(!result||!Number.isSafeInteger(result.score))continue;
    task.profit+=result.score;task.totalBetAmount+=task.betAmount;task.completedCount++;
    if(result.score>0)task.winCount++;else if(result.score<0)task.loseCount++;
    task.profitTrend.push(task.profit);delete task.pendingInning;delete task.activeAttempt;task.lastSettledInning=inning;task.version++;
    if(task.stopping||task.completedCount>=task.stopCountLimit||task.takeProfit>0&&task.profit>=task.takeProfit||task.stopLoss>0&&task.profit<=-task.stopLoss)
      stop(task,task.stopReason|| (task.completedCount>=task.stopCountLimit?'COUNT_LIMIT':task.profit>=task.takeProfit&&task.takeProfit>0?'TAKE_PROFIT':'STOP_LOSS'));
    writeLater(task);
   }
  };
  Object.defineProperty(record,recordHook,{value:original});
  Object.defineProperty(table,'recordUserCenter',{configurable:true,value:record});
 }
 for(const table of runtime.registry.tables.values())install(table);
 const currentSet=runtime.registry.setTable;
 const originalSet=Object.hasOwn(currentSet,tableHook)?currentSet[tableHook]:currentSet;
 const setTable=(...args)=>{const table=originalSet.apply(runtime.registry,args);install(table);return table};
 Object.defineProperty(setTable,tableHook,{value:originalSet});runtime.registry.setTable=setTable;
 async function list(user,roomType){
  const local=[...resident.tasks.values()].filter(task=>own(task,user)&&task.roomType===roomType&&!task.deleted);
  if(runtime.env!=='prod')return local.map(project);
  const remote=await (runtime.gateway||runtime.rpc?.gateway).smartTask('list',{...user,roomType});
  if(!Array.isArray(remote))throw fail(503,'任务存储返回无效列表');
  const rows=new Map(remote.filter(task=>own(task,user)&&task.roomType===roomType&&!task.deleted).map(task=>[task.taskId,task]));
  for(const task of local){
   const stored=rows.get(task.taskId);
   if(!stored){
    if(task.status==='stopped'&&!task.pendingInning&&!resident.pending.has(task.taskId)){
      if(!task.activeAttempt)forgetLocal(task.taskId,task);
    }
    continue;
   }
   // A locally newer financial snapshot must keep a durable stop request.
   if(stored&&Number(stored.version)>task.version)continue;
   rows.set(task.taskId,{...task,...(stored?.control?{control:stored.control}:{})});
  }
  return [...rows.values()].filter(task=>!task.deleted).map(project);
 }
 async function command(user,request){
  prune();
  const roomType=Number(request.roomType);if(![58,59].includes(roomType))throw fail(400,'固定智能投注仅支持百家乐及龙虎');
  if(request.action==='list')return {myTasks:await list(user,roomType)};
  if(request.action==='create'){
   if(request.strategy!=='FIXED')throw fail(501,'本次仅开放固定区域策略，请使用固定投注配置');
   const roomId=Number(request.roomId),areaId=Number(request.areaId),betAmount=Number(request.betAmount),count=Number(request.stopCountLimit),takeProfit=Number(request.takeProfit||0),stopLoss=Number(request.stopLoss||0);
   if(!safe(roomId,1,Number.MAX_SAFE_INTEGER)||!safe(areaId,1,100)||!safe(betAmount,1,100000000)||!safe(count,1,1000)||!safe(takeProfit,0,100000000000)||!safe(stopLoss,0,100000000000))throw fail(400,'固定投注金额、区域、局数或止盈止损无效');
   const id=request.requestId;if(typeof id!=='string'||! /^[a-zA-Z0-9:_-]{1,100}$/.test(id))throw fail(400,'创建任务需唯一请求编号');
   const taskId=user.agentId+':'+user.userId+':'+id,existing=resident.tasks.get(taskId);
   if(existing){if(existing.roomId!==roomId||existing.areaId!==areaId||existing.betAmount!==betAmount||existing.stopCountLimit!==count||existing.takeProfit!==takeProfit||existing.stopLoss!==stopLoss)throw fail(409,'原任务编号配置冲突');return {code:0,taskId,taskDetail:project(existing)}}
   const known=await list(user,roomType);
   const previous=known.find(task=>task.taskId===taskId);
   if(previous){
    if(previous.roomId!==roomId||previous.areaId!==areaId||previous.betAmount!==betAmount||previous.stopCountLimit!==count||previous.takeProfit!==takeProfit||previous.stopLoss!==stopLoss)
      throw fail(409,'原任务编号配置冲突');
    return {code:0,taskId,taskDetail:previous};
   }
   if(resident.tasks.size>=10000)throw fail(503,'当前任务容量已满，请先清理已停止任务');
   if(known.length>=1000)throw fail(409,'任务历史已达上限，请先删除已停止的任务');
   if(known.some(task=>task.roomId===roomId&&task.status!=='stopped'&&!task.deleted))throw fail(409,'本房已有未完成任务');
   const game=gameOf(roomType),table=runtime.registry.getTable(roomId,user.agentId,game.id);
   const session=[...runtime.registry.sessions.values()].find(s=>s.userId===user.userId&&s.agentId===user.agentId&&s.authenticated!==false&&!s.superseded&&s.hundredRoomIds?.has(roomId));
   if(!table||!session)throw fail(403,'请先进入并订阅目标房间');
   if(runtime.env==='prod'&&!runtime.wallet?.lotteryFor?.(table))throw fail(503,'固定任务需要已启用的统一资金房间');
   if((table.playerBets.get(user.userId)||[]).length)throw fail(409,'请等待现有投注结算后再创建任务');
   const options=game.betOptions(table);if(!options.areas.some(a=>a.areaId===areaId)||betAmount<options.minBet||betAmount>options.maxBet)throw fail(400,'区域或金额超出房间限额');
   const task={taskId,...user,instanceId:resident.instance,roomId,roomType,areaId,betAmount,stopCountLimit:count,takeProfit,stopLoss,
    strategy:'FIXED',executionProtocol:2,stopByCountEnabled:true,createdAt:Date.now(),version:1,status:'running',completedCount:0,profit:0,totalBetAmount:0,winCount:0,loseCount:0,profitTrend:[]};
   const saved=await persist(task);
   if(saved?.task){if(!sameTask(task,saved.task)||saved.task.status!=='running'||saved.task.deleted||saved.task.pendingInning)throw fail(409,'原任务已有执行记录，请查询其状态');Object.assign(task,saved.task)}
   resident.tasks.set(taskId,task);table.smartTasks.set(taskId,task);return {code:0,taskId,taskDetail:project(task)};
  }
  if(!['detail','stop','delete','resolve'].includes(request.action))throw fail(400,'未知任务操作');
  if(runtime.env==='prod'){
   const gateway=runtime.gateway||runtime.rpc?.gateway;
   if(request.action==='detail'){
    const rows=await list(user,roomType),task=rows.find(item=>item.taskId===String(request.taskId));
    if(!task)throw fail(404,'没有该任务');return {taskDetail:task};
   }
   const response=await gateway.smartTask(request.action==='resolve'?'resolve':'control',{...user,roomType,taskId:String(request.taskId||''),action:request.action});
   const stored=response?.task;if(!stored||!own(stored,user)||stored.roomType!==roomType||stored.taskId!==String(request.taskId))throw fail(503,'任务控制回执不匹配');
   const local=resident.tasks.get(stored.taskId);
   if(local&&own(local,user)&&local.instanceId===resident.instance){
    if(!sameTask(local,stored))throw fail(503,'原任务配置不匹配');
    if(request.action==='resolve'){Object.assign(local,stored);delete local.activeAttempt;delete local.pendingInning;resident.pending.delete(local.taskId);confirmRetired(stored);}
    else if(stored.deleted){resident.pending.delete(local.taskId);forgetLocal(local.taskId,local);}
    else if(applyControl(local,stored.control)){await persist(structuredClone(local));}
    return {code:0,taskId:stored.taskId,taskDetail:project(stored.deleted?stored:local)};
   }
   return {code:0,taskId:stored.taskId,taskDetail:project(stored)};
  }
  const task=resident.tasks.get(String(request.taskId));
  if(!task||!own(task,user))throw fail(404,'当前执行实例没有该任务；请查询任务状态');
  if(request.action==='detail')return {taskDetail:project(task)};
  if(!['stop','delete'].includes(request.action))throw fail(400,'未知任务操作');
  if(request.action==='delete'&&(task.status!=='stopped'||task.pendingInning))throw fail(409,'请先停止任务并等待已受理投注结算');
  const next=structuredClone(task);if(request.action==='stop')stop(next,'USER_STOP');else{next.deleted=true;next.version++}
  await persist(next);Object.assign(task,next);
  if(next.deleted){resident.tasks.delete(task.taskId);for(const table of runtime.registry.tables.values())table.smartTasks?.delete(task.taskId)}
  return {code:0,taskId:task.taskId,taskDetail:project(task)};
 }
 async function refreshControls(table){
  if(runtime.env!=='prod')return true;
  const now=runtime.clock?.()??Date.now(),previous=table.smartControlRead;
  if(previous&&now>=previous.at&&now-previous.at<1000)return previous.ok;
  table.smartControlRead={at:now,ok:false};
  const tasks=[...table.smartTasks.values()].filter(task=>task.status==='running'||task.pendingInning);
  try{
   for(let offset=0;offset<tasks.length;offset+=100){
    const batch=tasks.slice(offset,offset+100),rows=await (runtime.gateway||runtime.rpc?.gateway).smartTask('readMany',{instanceId:resident.instance,taskIds:batch.map(task=>task.taskId)});
    if(!Array.isArray(rows)||rows.length!==batch.length||new Set(rows.map(row=>row.taskId)).size!==batch.length)throw fail(503,'任务控制查询不完整');
    for(const task of batch){const stored=rows.find(row=>row.taskId===task.taskId);
     if(stored&&sameTask(task,stored)&&stored.status==='stopped'&&stored.resolvedAt&&stored.version>task.version){
      Object.assign(task,stored);delete task.activeAttempt;delete task.pendingInning;resident.pending.delete(task.taskId);confirmRetired(stored);continue;
     }
     if(!stored||!sameTask(task,stored)||stored.deleted||stored.version>task.version)throw fail(503,'任务执行状态待确认');
     if(applyControl(task,stored.control))writeLater(task);
    }
   }
   table.smartControlRead={at:now,ok:true};return true;
  }catch(error){runtime.log.error('smart task control unavailable; new wagers paused',error.message);return false;}
 }
 async function tick(table){
  void flush();if(!table.smartTasks?.size)return;
  if(!await refreshControls(table))return;
  const game=gameOf(table.roomType);if(table.state!==game.betState()||table.closing||table.hundredCycleTask)return;
  for(const task of table.smartTasks.values()){
   if(task.status!=='running'||task.stopping||task.pendingInning||task.lastSettledInning===table.inning||resident.pending.has(task.taskId))continue;
   const session=[...runtime.registry.sessions.values()].find(s=>s.userId===task.userId&&s.agentId===task.agentId&&!s.superseded&&s.inRoom!==false&&s.hundredRoomIds?.has(table.roomId));
   if(!session){stop(task,'DISCONNECTED');writeLater(task);continue}
   if(runtime.env==='prod'){
    if(task.executionProtocol!==2||task.activeAttempt)continue;
    const route=runtime.wallet.lotteryFor?.(table)?.identity(table,financeRound(table));
    if(!route)continue;
    const attempt={roundId:route.roundId,agent:route.agent,gameId:route.gameId,level:route.level,inning:table.inning,attemptId:randomUUID(),areaId:task.areaId};
    try{
     const receipt=await (runtime.gateway||runtime.rpc?.gateway).smartTask('begin',{agentId:task.agentId,userId:task.userId,roomType:task.roomType,taskId:task.taskId,instanceId:resident.instance,expectedVersion:task.version,attempt});
     const stored=receipt?.task;
     if(!stored||!sameTask(task,stored)||stored.version!==task.version+1||stored.activeAttempt?.attemptId!==attempt.attemptId||stored.activeAttempt.roundId!==attempt.roundId)throw fail(503,'投注执行登记未确认');
     Object.assign(task,stored);
    }catch(error){runtime.log.error('smart wager execution registration pending; no new wager submitted',error.message);continue}
   }
   let accepted=false;
   const ctx={runtime,table,session,smartBet:true,smartAttemptId:task.activeAttempt?.attemptId,io:ioOf(table),send:(_id,payload)=>{if(payload?.code===0)accepted=true}};
   if(game.placeBet(ctx,{roomId:table.roomId,roomType:table.roomType,params:[{areaId:task.areaId,total:task.betAmount}],customData:2})!==true||!accepted){delete task.activeAttempt;stop(task,'WAGER_REJECTED');writeLater(task);continue}
   task.pendingInning=table.inning;task.version++;writeLater(task);
  }
 }
 // Reconfirm stopped resident records once after this upgrade. Without the
 // original SQL acknowledgement, an old local stopped flag is not sufficient.
 if(runtime.env==='prod'&&!resident.retentionInitialized){
  resident.retentionInitialized=true;
  for(const task of resident.tasks.values())if(terminal(task)&&!resident.pending.has(task.taskId))resident.pending.set(task.taskId,structuredClone(task));
 }
 return {command,tick,flush};
}
