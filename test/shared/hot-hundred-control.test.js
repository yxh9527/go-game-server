import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {hundredControlFixture,smartRuntime} from '../fixtures/hot-hundred-control.mjs';

test('accepted smart wager and stop state survive replacement and settlement is counted once',async()=>{
  const f=hundredControlFixture(),x=smartRuntime();
  try{
    f.write(0);const old=(await f.load('smart-bet.js',0)).createSmartBet(x.runtime,()=>x.game,()=>x.io),created=await old.command(x.user,x.request);
    await old.tick(x.table);assert.equal(x.bets,1);const owner=x.runtime.smartBetState,task=owner.tasks.get(created.taskId);
    f.write(1);const next=(await f.load('smart-bet.js',1)).createSmartBet(x.runtime,()=>x.game,()=>x.io);
    assert.equal(x.runtime.smartBetState,owner);assert.equal((await next.command(x.user,x.request)).taskId,created.taskId);
    await next.command(x.user,{action:'stop',roomType:58,taskId:created.taskId});await old.tick(x.table);await next.tick(x.table);assert.equal(x.bets,1);
    x.table.recordUserCenter([{uid:42,score:100}],{inning:1});x.table.recordUserCenter([{uid:42,score:100}],{inning:1});
    assert.equal(task.completedCount,1);assert.equal(task.profit,100);assert.equal(task.status,'stopped');assert.equal(x.records,2);
    await next.command(x.user,{action:'delete',roomType:58,taskId:created.taskId});assert.equal(owner.tasks.size,0);assert.equal(x.table.smartTasks.size,0);
  }finally{f.close();}
});

test('a pending card payout returns the original promise across replacement and credits once',async()=>{
  const f=hundredControlFixture();let release,credits=0,records=0;
  const session={userId:42,agentId:7,wallet:900},result={areas:[1]},table={roomId:5801,roomType:58,inning:1,lastResult:result,playerBets:new Map([[42,[{areaId:1,total:100}]]]),playerSessions:new Map([[42,session]]),recordUserCenter(){records++;}};
  const wallet={carryEnabled:true,credit:async(_session,amount)=>{credits++;await new Promise(resolve=>{release=resolve;});session.wallet+=amount;return {ok:true};},persist:async()=>{}};
  const io={wallet,forEachPlayer:fn=>fn(session),sendUser(){}};
  const adapter={calculate:()=>({payout:200,realScore:100,areaWinningScores:{1:100}}),resultPayload:()=>({}),snapshot:()=>({}),record(){},bankerAreas:[]};
  try{
    f.write(0);const old=await f.load('hundred-card-payout.js',0),pending=old.settleCardBets(io,table,adapter);await new Promise(resolve=>setImmediate(resolve));assert.equal(credits,1);
    f.write(1);const next=await f.load('hundred-card-payout.js',1);assert.equal(next.settleCardBets(io,table,adapter),pending);assert.equal(result.cardPayoutTask,pending);
    release();await pending;assert.equal(credits,1);assert.equal(session.wallet,1100);assert.equal(records,1);assert.equal(result.settled,true);assert.equal(result.cardPayoutTask,undefined);
    assert.equal(next.settleCardBets(io,table,adapter),undefined);assert.equal(credits,1);
  }finally{release?.();f.close();}
});

test('owner release and next-round settings survive replacement without affecting the running hand',async()=>{
  const f=hundredControlFixture(),table={roomId:5801,roomType:58,playMode:4,playerBets:new Map([[42,[{areaId:1,total:100}]]]),baccaratOwner:{uid:42},baccaratOwnerSettings:{betTime:20,peekTime:10},baccaratOwnerPending:{betTime:30},lastResult:{settled:false}},io={broadcast(){}};
  try{
    f.write(0);const old=await f.load('hundred-table-owner.js',0);old.leave({table,session:{userId:42},io});const owner=table.baccaratOwner;assert.equal(owner.releasePending,true);
    f.write(1);const next=await f.load('hundred-table-owner.js',1);assert.equal(next.privilege(table).activeBetTime,20);assert.equal(table.baccaratOwner,owner);
    table.lastResult.settled=true;next.beforeRound(io,table);assert.equal(table.baccaratOwner,null);assert.equal(table.baccaratOwnerSettings.betTime,30);assert.equal(table.baccaratOwnerPending,undefined);
    const limits=await f.load('cash-limits.js',1),full={playerBets:new Map(Array.from({length:limits.MAX_HUNDRED_BETTORS},(_,i)=>[i,[{total:1}]]))};assert.equal(limits.canAddHundredBettor(full,5000),false);assert.equal(limits.canAddHundredBettor(full,42),true);
  }finally{f.close();}
});

test('released smart hooks, card payout and table-owner modules can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-hundred-control.mjs','--hundred-control-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_HUNDRED_CONTROL_GC/);
});
