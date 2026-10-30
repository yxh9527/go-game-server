import test from 'node:test';
import assert from 'node:assert/strict';
import * as banker from '../../../game-server/src/core/hundred-banker.js';
import { BaccaratGame } from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import * as engine from '../../../game-server/src/games/baccarat/engine.js';
import * as history from '../../../game-server/src/games/baccarat/history.js';

const groups = [[1,2,3,9],[4,5,6,7,8]];
function fixture() {
  const game=new BaccaratGame(),table=game.createTable(1400001,58,{robot_behavior:{enabled:false}});
  const session={userId:17,wallet:1000000},messages=[],debits=[],credits=[];
  const wallet={debit(s,n){debits.push(n);if(s.wallet<n)return {ok:false};s.wallet-=n;return {ok:true};},
    credit(s,n){credits.push(n);s.wallet+=n;return {ok:true};},async persist(){}};
  const io={wallet,broadcast(id,data){messages.push({id,data:structuredClone(data)});},
    sendUser(uid,id,data){messages.push({uid,id,data:structuredClone(data)});},forEachPlayer(fn){fn(session);}};
  const ctx={game,table,session,io,runtime:{wallet},send:(id,data)=>io.sendUser(17,id,data)};
  game.enter(table,session);
  const request=(id,body={bankerType:1,amount:10000,maxWinLoseAmount:10000})=>banker.request(ctx,id,body,groups);
  return {game,table,session,messages,ctx,io,wallet,debits,credits,request};
}

test('Hundred banker validates room, amounts, caps, duplicates, counts and disabled tables before debit',()=>{
  const f=fixture();
  for(const body of [null,[],{bankerType:3},{bankerType:1,amount:NaN,maxWinLoseAmount:10000},
    {bankerType:1,amount:10001,maxWinLoseAmount:10000},{bankerType:1,amount:10000,maxWinLoseAmount:20000},
    {bankerType:1,amount:10000,maxWinLoseAmount:10000,roomId:999}]) {
    f.request(6133,body);assert.equal(f.messages.findLast(m=>m.id===6240).data.code,1);
  }
  assert.equal(f.table.hundredBankers.entries.length,0);assert.deepEqual(f.debits,[]);
  banker.request(f.ctx,6133,{bankerType:1,amount:10000,maxWinLoseAmount:10000},groups,false);
  assert.equal(f.table.hundredBankers.entries.length,0);
  f.request(6133);assert.equal(f.messages.findLast(m=>m.id===6240).data.code,0);
  f.request(6133);assert.equal(f.table.hundredBankers.entries.length,1);
  f.request(6135,{bankerType:1,bankerCount:11});assert.equal(f.messages.findLast(m=>m.id===6242).data.code,3);
});

test('Hundred banker defers funding to a serialized hand boundary and blocks playing against own bank',async()=>{
  const f=fixture();f.request(6133);assert.equal(f.session.wallet,1000000);assert.equal(banker.isBanker(f.table,17),false);
  const task=banker.boundary(f.ctx,groups);assert.equal(banker.boundary(f.ctx,groups),task);await task;
  assert.deepEqual(f.debits,[10000]);assert.equal(f.session.wallet,990000);assert.equal(banker.isBanker(f.table,17),true);
  await banker.boundary(f.ctx,groups);assert.deepEqual(f.debits,[10000]);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),false);
  const list=banker.list(f.table,groups);assert.equal(list.normalBankerDataList[0].amount,10000);
});

test('Hundred banker funding persistence failure retries without a second debit',async()=>{
  const f=fixture();f.request(6133);let fail=true;
  f.wallet.persist=async()=>{if(fail)throw Error('persist down');};
  await assert.rejects(banker.boundary(f.ctx,groups),/persist down/);
  assert.deepEqual(f.debits,[10000]);assert.equal(f.table.hundredBankers.entries[0].dirty,true);
  fail=false;await banker.boundary(f.ctx,groups);
  assert.deepEqual(f.debits,[10000]);assert.equal(f.session.wallet,990000);
});

test('Hundred banker downward change refunds once even if persistence fails after credit',async()=>{
  const f=fixture();f.request(6133,{bankerType:1,amount:20000,maxWinLoseAmount:20000});await banker.boundary(f.ctx,groups);
  f.request(6135,{bankerType:1,amount:10000,maxWinLoseAmount:10000});f.table.inning++;
  let fail=true;f.wallet.persist=async()=>{if(fail)throw Error('persist down');};
  await assert.rejects(banker.boundary(f.ctx,groups),/persist down/);assert.equal(f.session.wallet,990000);
  fail=false;await banker.boundary(f.ctx,groups);
  assert.deepEqual(f.credits,[10000]);assert.equal(f.table.hundredBankers.entries[0].amount,10000);
});

test('Hundred banker pending refund survives disconnect and hot reload without removing another entry',async()=>{
  const f=fixture();f.request(6133);await banker.boundary(f.ctx,groups);
  const other={...f.ctx,session:{userId:18,wallet:1000000}};
  banker.request(other,6133,{bankerType:1,amount:10000,maxWinLoseAmount:10000},groups);
  f.request(6134,{bankerType:1});f.table.inning++;
  let fail=true;const credit=f.wallet.credit;f.wallet.credit=(s,n)=>fail?{ok:false}:credit(s,n);
  await assert.rejects(banker.boundary(f.ctx,groups),/refund rejected/);
  banker.leave(f.table,f.session);assert.equal(f.table.hundredBankers.entries.length,2);
  const reloaded=await import('../../../game-server/src/core/hundred-banker.js?v=refund-reload');
  fail=false;await reloaded.boundary(f.ctx,groups);
  assert.equal(f.session.wallet,1000000);assert.deepEqual(f.credits,[10000]);
  assert.deepEqual(f.table.hundredBankers.entries.map(e=>e.uid),[18]);
});

test('Hundred banker disconnected queue cancels and active bank refunds only at next boundary',async()=>{
  const f=fixture();f.request(6133);banker.leave(f.table,f.session);assert.equal(f.table.hundredBankers.entries.length,0);
  assert.deepEqual(f.debits,[]);f.request(6133);await banker.boundary(f.ctx,groups);
  banker.leave(f.table,f.session);assert.equal(f.session.wallet,990000);
  banker.bind(f.table,f.session);assert.equal(f.table.hundredBankers.entries[0].pendingCancel,false);
  banker.leave(f.table,f.session);f.table.inning++;await banker.boundary(f.ctx,groups);
  assert.equal(f.session.wallet,1000000);assert.equal(f.table.hundredBankers.entries.length,0);
});

test('Hundred banker caps total exposure and splits escrow losses once, system covers remainder',async()=>{
  const f=fixture();f.request(6133);await banker.boundary(f.ctx,groups);
  const second={...f.ctx,session:{userId:18,wallet:1000000}};
  banker.request(second,6133,{bankerType:1,amount:20000,maxWinLoseAmount:20000},groups);f.table.inning++;await banker.boundary(f.ctx,groups);
  f.table.totalBetsByArea.find(b=>b.areaId===1).total=100000;
  f.table.preparedHand={};banker.lock(f.table,f.table.preparedHand,groups,engine.currentOdds(f.table));
  const result={settlements:new Map([[19,{areaWinningScores:{1:100000}}]])};
  banker.settle(f.io,f.table,result,groups);banker.settle(f.io,f.table,result,groups);
  assert.deepEqual(f.table.hundredBankers.entries.map(e=>e.amount),[0,0]);
  assert.deepEqual(f.table.hundredBankers.entries.map(e=>e.totalWinLoseAmount),[-10000,-20000]);
  assert.equal(f.messages.filter(m=>m.id===6244).length,2);
  f.table.inning++;await banker.boundary(f.ctx,groups);assert.equal(f.table.hundredBankers.entries.length,0);
  assert.equal(f.session.wallet,990000);assert.equal(second.session.wallet,980000);
});

test('Hundred banker dual regions share one player result and conserve all covered gains',async()=>{
  const f=fixture();f.request(6133);f.request(6133,{bankerType:2,amount:10000,maxWinLoseAmount:10000});await banker.boundary(f.ctx,groups);
  f.table.totalBetsByArea.find(b=>b.areaId===1).total=100;
  f.table.totalBetsByArea.find(b=>b.areaId===4).total=100;
  f.table.preparedHand={};banker.lock(f.table,f.table.preparedHand,groups,engine.currentOdds(f.table));
  const result={settlements:new Map([[19,{areaWinningScores:{1:-100,4:-100}}]])};
  banker.settle(f.io,f.table,result,groups);
  assert.equal(f.messages.findLast(m=>m.id===6244).data.score,200);
  assert.equal(f.messages.findLast(m=>m.id===6244).data.areas.length,2);
  f.request(6134,{bankerType:1});f.request(6134,{bankerType:2});f.table.inning++;await banker.boundary(f.ctx,groups);
  assert.equal(f.session.wallet,1000200);assert.deepEqual(f.credits,[10100,10100]);
});

test('Hundred banker single-hand win cap also applies to low-odds not-tie stakes',async()=>{
  const f=fixture();f.request(6133);await banker.boundary(f.ctx,groups);
  f.table.totalBetsByArea.find(b=>b.areaId===9).total=100000;
  f.table.preparedHand={};banker.lock(f.table,f.table.preparedHand,groups,engine.currentOdds(f.table));
  const result={settlements:new Map([[19,{areaWinningScores:{9:-100000}}]])};
  banker.settle(f.io,f.table,result,groups);
  assert.equal(f.table.hundredBankers.entries[0].totalWinLoseAmount,10000);
  assert.equal(f.table.hundredBankers.entries[0].amount,20000);
});

test('Hundred banker preflight failure cannot partially apply a previous banker and doubles never count',async()=>{
  const f=fixture();f.request(6133);await banker.boundary(f.ctx,groups);
  const first=f.table.hundredBankers.entries[0],second={...first,uid:18,amount:0};
  f.table.preparedHand={bankerExposure:[10000,0],bankers:[{entry:first,cap:10000,denominator:20000,bankerType:1},{entry:second,cap:10000,denominator:20000,bankerType:1}]};
  const result={settlements:new Map([[19,{areaWinningScores:{1:10000}}]])};
  assert.throws(()=>banker.settle(f.io,f.table,result,groups),/exposure exceeded/);
  assert.equal(first.amount,10000);assert.equal(first.totalBankerCount,0);
  second.amount=10000;banker.settle(f.io,f.table,result,groups);banker.settle(f.io,f.table,result,groups);
  assert.equal(first.amount,5000);assert.equal(first.totalBankerCount,1);assert.equal(second.amount,5000);
});

test('Baccarat waits for banker completion after player credit and retries without paying player twice',async()=>{
  const f=fixture();assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),true);
  const e={uid:18,amount:0,maxWinLoseAmount:10000,totalBankerCount:0,totalWinLoseAmount:0};
  f.table.preparedHand.bankers=[{entry:e,cap:10000,denominator:10000,bankerType:1}];f.table.preparedHand.bankerExposure=[100,0];
  f.table.lastResult={player:[3,4],banker:[0,1],p:9,b:3,areas:[1]};
  await assert.rejects(engine.applyCycle(f.io,f.table,6),/exposure exceeded/);
  assert.equal(f.table.lastResult.settled,undefined);assert.equal(f.session.wallet,1000100);
  e.amount=10000;await engine.applyCycle(f.io,f.table,6);
  assert.equal(f.session.wallet,1000100);assert.deepEqual(f.credits,[200]);assert.equal(e.amount,9900);
  assert.equal(f.table.lastResult.settled,true);
});

test('Baccarat banker review returns original own-region summary instead of an empty betting panel',async()=>{
  const f=fixture();f.request(6133);await banker.boundary(f.ctx,groups);
  const bettor={userId:18,wallet:1000000};f.game.enter(f.table,bettor);
  const ctx={...f.ctx,session:bettor};f.game.placeBet(ctx,{params:[{areaId:1,total:100}]});
  engine.applyCycle(f.io,f.table,3);
  f.table.lastResult={player:[3,4],banker:[0,1],p:9,b:3,areas:[1]};
  await engine.applyCycle(f.io,f.table,6);
  const detail=await history.detail(f.ctx,1);
  assert.equal(detail.bankerInningData.bankerInningInfoMap[17].dataMap[1].score,-100);
  assert.equal(detail.bankerInningData.bankerAreaTotalBet[1],100);
  assert.equal(detail.bankerInningData.bankerTotalWinLoseMap[1],-100);
  const player=await history.detail(ctx,1);assert.equal(player.bankerInningData,undefined);
  assert.equal(player.betDetailTableMap[1].realScore,100);
});
