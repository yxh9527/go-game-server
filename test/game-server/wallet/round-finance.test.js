import {importHotModule} from "../../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {createRoundFinance,scoreToMoney,moneyToScore}=await importHotModule(new URL('../../../game-server/src/wallet/round-finance.js',import.meta.url).href,'round-controller-regression');
const {createGameRouteIndex}=await importHotModule(new URL("../../../shared/rpc/game-routes.js",import.meta.url).href,"financial-route-selected-tests");

function fixture(){
  const calls=[],bets=new Map(),balances=new Map([[42,10000],[43,10000]]);
  let revision=0,reservation,settlement,timeout='',queryFails=false,now=Date.now();
  const common={async finance(method,request,agent){
    calls.push({method,request:structuredClone(request),agent});
    if(method==='getRoundFinanceState'){
      if(queryFails)throw Object.assign(new Error('unavailable'),{code:14});
      return {code:0,roundId:request.roundId,state:settlement?'SETTLED':reservation?'RESERVED':'BETTING'};
    }
    let response;
    const header={code:0,roundId:request.roundId};
    if(method==='bet'){
      response={...header,state:'BETTING',betDigest:'digest-'+(bets.size+request.items.length),items:request.items.map(item=>{
        if(!bets.has(item.betId)){bets.set(item.betId,item);balances.set(item.userId,balances.get(item.userId)-moneyToScore(item.amount));}
        return {code:0,betId:item.betId,userId:item.userId,accepted:true,currency:scoreToMoney(balances.get(item.userId))};
      })};
    }
    if(method==='cancelBet'){
      let refund=0;for(const [id,b]of bets)if(b.userId===request.userId){refund+=moneyToScore(b.amount);bets.delete(id);}
      balances.set(request.userId,balances.get(request.userId)+refund);
      response={...header,state:'BETTING',success:true,refundAmount:scoreToMoney(refund),currency:scoreToMoney(balances.get(request.userId)),betDigest:'canceled-digest',betRevision:String(++revision)};
    }
    if(method==='prePay')response=reservation||=( {...header,state:'RESERVED',success:true,reservationId:'res-one',outcomeHash:request.outcomeHash,
      betDigest:request.betDigest,expiresAt:String(Math.floor(now/1000)+60)});
    if(method==='renewReservation')response={...header,success:true,state:'RESERVED',reservationId:reservation.reservationId,expiresAt:String(Math.floor(now/1000)+60)};
    if(method==='settlement'){
      if(!settlement){for(const item of request.items)balances.set(item.userId,balances.get(item.userId)+moneyToScore(item.payout));
        settlement={...header,state:request.mode==='VOID_REFUND'?'VOIDED':'SETTLED',settlementId:request.settlementId,
          items:request.items.map(item=>({userId:item.userId,code:0,currency:scoreToMoney(balances.get(item.userId))}))};}
      response=settlement;
    }
    if(timeout===method){timeout='';throw Object.assign(new Error('deadline after commit'),{code:4});}
    return response;
  }};
  const routes=createGameRouteIndex([{gameType:1000,roomType:50,number:91002,symbol:'test-hundred',state:1,isFrozen:0}]);
  const table={agentId:7,cfg:{game_type:1000,room_type:50,finance_level:1}},round={},session={userId:42,agentId:7,currency:'CNY'};
  const controller=createRoundFinance(common,{routes,clock:()=>now});
  return {table,round,session,common,controller,calls,balances,bets,advance:ms=>{now+=ms;},timeout:method=>{timeout=method;},failQuery:()=>{queryFails=true;}};
}

test('final display metadata may attach after reservation while economic and original game results remain locked',async()=>{
 const f=fixture();await f.controller.bet(f.table,f.round,f.session,[{amount:100}]);
 const original={roomId:1,result:'actual'};await f.controller.reserve(f.table,f.round,[{session:f.session,payout:200,record:original}],{winner:42});
 await f.controller.settle(f.table,f.round,[{session:f.session,payout:200,record:{...original,completedDisplayReport:{id:'actual-report'}}}],{winner:42});
 assert.equal(f.calls.filter(c=>c.method==='prePay').length,1);
 const changed=fixture();await changed.controller.bet(changed.table,changed.round,changed.session,[{amount:100}]);
 await changed.controller.reserve(changed.table,changed.round,[{session:changed.session,payout:200,record:original}],{winner:42});
 await assert.rejects(()=>changed.controller.settle(changed.table,changed.round,[{session:changed.session,payout:200,record:{...original,result:'changed',completedDisplayReport:{id:'report'}}}],{winner:42}),/outcome changed/);
 assert.equal(changed.calls.some(c=>c.method==='settlement'),false);
});
test('Lottery lifecycle preserves route, revision, server digest and the settlement ID across timeout',async()=>{
  const f=fixture(),operation={};f.timeout('bet');
  const paid=await f.controller.bet(f.table,f.round,f.session,[{areaId:'1',amount:100}],operation);
  assert.equal(paid.balance,9900);assert.equal(f.bets.size,1);
  assert.deepEqual(f.calls.slice(0,3).map(c=>c.method),['bet','getRoundFinanceState','bet']);
  assert.deepEqual(f.calls[0].request,f.calls[2].request);
  await f.controller.bet(f.table,f.round,f.session,[{areaId:'1',amount:100}],operation);assert.equal(f.bets.size,1);
  const canceled=await f.controller.cancel(f.table,f.round,f.session);assert.equal(canceled.refund,100);
  await f.controller.bet(f.table,f.round,f.session,[{areaId:'2',amount:200}]);
  assert.match(f.calls.filter(c=>c.method==='bet').at(-1).request.items[0].betId,/:rev:1:/);
  f.timeout('settlement');
  const result=await f.controller.settle(f.table,f.round,[{session:f.session,payout:300}],{winningArea:2,cards:[1,2]});
  assert.equal(result.balances.get(42),10100);assert.equal(f.balances.get(42),10100);
  const settlements=f.calls.filter(c=>c.method==='settlement');assert.equal(settlements.length,2);
  assert.deepEqual(settlements[0].request,settlements[1].request);
  assert.ok(f.calls.filter(c=>c.method!=='getRoundFinanceState').every(c=>c.request.gameId===91002&&c.agent===7));
});
test('incomplete account coverage, changed outcomes and mismatched identities never issue new money commands',async()=>{
  const f=fixture(),other={...f.session,userId:43};
  await f.controller.bet(f.table,f.round,f.session,[{amount:100}]);
  await f.controller.bet(f.table,f.round,other,[{amount:100}]);
  assert.throws(()=>f.controller.settle(f.table,f.round,[{session:f.session,payout:100}],{}),/every active account/);
  assert.throws(()=>f.controller.bet(f.table,f.round,{...f.session,agentId:8},[{amount:100}]),/identity mismatch/);
  await f.controller.settle(f.table,f.round,[{session:f.session,payout:100},{session:other,payout:0}],{winner:42});
  assert.throws(()=>f.controller.settle(f.table,f.round,[{session:f.session,payout:101},{session:other,payout:0}],{winner:43}),/changed/);
  assert.equal(f.calls.filter(c=>c.method==='settlement').length,1);
});
test('failed confirmation pauses the round and cannot invent another bet ID',async()=>{
  const f=fixture();f.timeout('bet');f.failQuery();
  await assert.rejects(()=>f.controller.bet(f.table,f.round,f.session,[{amount:100}]),e=>e.code==='FINANCE_CONFIRMATION_REQUIRED');
  await assert.rejects(()=>f.controller.bet(f.table,f.round,f.session,[{amount:100}]),e=>e.code==='FINANCE_CONFIRMATION_REQUIRED');
  assert.equal(f.calls.filter(c=>c.method==='bet').length,1);assert.equal(f.balances.get(42),9900);
});
test('score conversions never use floating point for currency serialization',()=>{
  assert.equal(scoreToMoney(Number.MAX_SAFE_INTEGER),'90071992547409.91');
  assert.equal(scoreToMoney(-101,true),'-1.01');assert.equal(moneyToScore('90071992547409.91'),Number.MAX_SAFE_INTEGER);
  for(const input of [NaN,Infinity,1.5,-1])assert.throws(()=>scoreToMoney(input));
});

test('reservations renew with RenewReservation, preserve the adopted outcome and never repeat PrePay',async()=>{
  const f=fixture();await f.controller.bet(f.table,f.round,f.session,[{amount:100}]);
  const results=[{session:f.session,payout:200}],outcome={winner:42};
  await f.controller.reserve(f.table,f.round,results,outcome);
  await f.controller.renew(f.table,f.round);assert.equal(f.calls.filter(c=>c.method==='renewReservation').length,0);
  f.advance(25000);await f.controller.renew(f.table,f.round);
  assert.equal(f.calls.filter(c=>c.method==='renewReservation').length,1);
  await f.controller.settle(f.table,f.round,results,outcome);
  assert.equal(f.calls.filter(c=>c.method==='prePay').length,1);
  assert.equal(f.calls.find(c=>c.method==='settlement').request.reservationId,'res-one');
});

test('a reservation cannot be reused for a changed complete game result',async()=>{
  const f=fixture();await f.controller.bet(f.table,f.round,f.session,[{amount:100}]);
  await f.controller.reserve(f.table,f.round,[{session:f.session,payout:200}],{winner:42});
  await assert.rejects(()=>f.controller.settle(f.table,f.round,[{session:f.session,payout:100}],{winner:43}),/outcome changed/);
  assert.equal(f.calls.some(c=>c.method==='settlement'),false);
});
