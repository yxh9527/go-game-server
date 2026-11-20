import test from 'node:test';
import assert from 'node:assert/strict';
import {loadGames} from '../../../game-server/src/games/catalog.js';
import {seedRooms} from '../../../cache/rpc/seed.js';
import {createRegistry,findConfig} from '../../../game-server/src/registry.js';
import {createHandler} from '../../../game-server/src/create-handler.js';
import {loadEnv} from '../../../shared/rpc/env.js';
import {createAuthoritativeWallet} from '../../../game-server/src/wallet/authoritative.js';
import {createRoundFinance,scoreToMoney,moneyToScore} from '../../../game-server/src/wallet/round-finance.js';
import {createGameRouteIndex} from '../../../shared/rpc/game-routes.js';
import {SEND,PUSH} from '../../../game-server/src/messages.js';
import {installUserCenter} from '../../../game-server/src/core/user-center.js';

const games=await loadGames('lottery-flow'),configs=seedRooms();
async function fixture(game){
  const cfg={...configs.find(row=>game.roomTypes.includes(Number(row.room_type))),finance_level:1};
  const balances=new Map([[42,1000000]]),accepted=new Map(),calls=[],events=[];let digest=0,revision=0;
  const common={async cashRead(account){return {...account,balance:balances.get(account.userId),revision,carry:null,ttlMs:0};},
    async cashApply(){assert.fail('A Lottery wager or payout must never also use cashApply');},
    async finance(method,request){
      calls.push({method,request:structuredClone(request)});
      events.push('rpc:'+method);
      const base={code:0,roundId:request.roundId};
      if(method==='bet')return {...base,state:'BETTING',betDigest:'digest-'+(++digest),items:request.items.map(item=>{
        if(!accepted.has(item.betId)){accepted.set(item.betId,item);balances.set(item.userId,balances.get(item.userId)-moneyToScore(item.amount));revision++;}
        return {code:0,accepted:true,betId:item.betId,userId:item.userId,currency:scoreToMoney(balances.get(item.userId))};
      })};
      if(method==='cancelBet'){
        let refund=0;for(const [key,item]of accepted)if(item.userId===request.userId){refund+=moneyToScore(item.amount);accepted.delete(key);}
        balances.set(request.userId,balances.get(request.userId)+refund);revision++;
        return {...base,success:true,state:'BETTING',refundAmount:scoreToMoney(refund),currency:scoreToMoney(balances.get(request.userId)),betRevision:'1',betDigest:'cancel-digest'};
      }
      if(method==='prePay')return {...base,success:true,state:'RESERVED',reservationId:'res-test',expiresAt:String(Math.floor(Date.now()/1000)+60),betDigest:request.betDigest,outcomeHash:request.outcomeHash};
      if(method==='settlement')return {...base,state:'SETTLED',settlementId:request.settlementId,items:request.items.map(item=>{
        balances.set(item.userId,balances.get(item.userId)+moneyToScore(item.payout));revision++;
        return {userId:item.userId,code:0,currency:scoreToMoney(balances.get(item.userId))};
      })};
      assert.fail('unexpected financial call '+method);
    }};
  const wallet=createAuthoritativeWallet({common}),registry=createRegistry(),session={userId:42,agentId:7,currency:'CNY',authenticated:true};
  await wallet.load(session);registry.bind({},session);
  const table=game.createTable(Number(cfg.game_room_config_id)*10000+Number(cfg.room_index||0),cfg.room_type,cfg);table.agentId=7;
  registry.setTable(table.roomId,table,7,game.id);
  wallet.configureLottery(createRoundFinance(common,{routes:createGameRouteIndex([{gameType:cfg.game_type,roomType:cfg.room_type,number:91000+cfg.room_type,symbol:'test-'+game.id,state:1,isFrozen:0}])}),[cfg.room_type]);
  const messages=[],send=(id,payload)=>wallet.deliver(()=>{events.push('message:'+id);messages.push({id,payload});});
  const io={env:'prod',wallet,send:(_ws,id,payload)=>send(id,payload),broadcast:send,sendUser:(_uid,id,payload)=>send(id,payload),forEachPlayer:fn=>fn(session),sessionFor:()=>session};
  const runtime={env:'prod',registry,wallet,configs:[cfg],log:{error(){}}};
  installUserCenter(runtime);
  const ctx={table,session,wallet,io,runtime,send};
  await wallet.run(()=>game.onMessage(ctx,SEND.ENTER,{roomId:table.roomId,roomType:table.roomType,vipTableMode:1}),runtime);
  if(game.engine?.beginRound)await wallet.run(()=>game.engine.beginRound(io,table),runtime);
  if(game.engine?.prepareHand&&!table.preparedHand)await wallet.run(()=>game.engine.prepareHand(io,table),runtime);
  table.state=game.engine?.PHASE?.BETTING??game.betState();table.phaseEndsAt=Date.now()+60000;
  const options=game.betOptions(table),area=options.areas.find(row=>row.odds>0)||options.areas[0];
  return {game,table,session,wallet,runtime,ctx,calls,messages,balances,common,events,amount:options.minBet,area:area.areaId,
    bet:()=>wallet.run(()=>game.placeBet(ctx,{roomId:table.roomId,roomType:table.roomType,params:[{areaId:area.areaId,total:options.minBet}]}),runtime)};
}
for(const game of games.list.filter(game=>game.kind==='hundred'))test('actual '+game.id+' wager exclusively commits through Lottery',async()=>{
  const f=await fixture(game),before=f.session.wallet;
  assert.equal(await f.bet(),true);const factor=f.table.hand?.betReserveFactor||f.table.config.betBalanceFactor||1;
  assert.equal(f.session.wallet,before-f.amount*factor);assert.equal(f.balances.get(42),f.session.wallet);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].method,'bet');assert.equal(f.calls[0].request.gameId,91000+f.table.roomType);
  assert.equal(f.messages.filter(m=>m.payload?.code===0&&m.payload?.myBets?.length).length,1);
});

async function reveal(f){
  if(f.game.engine.applyCycle)await f.wallet.run(()=>f.game.engine.applyCycle(f.ctx.io,f.table,4),f.runtime);
  else for(let step=0;step<5&&!f.calls.some(call=>call.method==='prePay');step++)
    await f.wallet.run(()=>f.game.engine.tick(f.ctx.io,f.table,f.table.phaseEndsAt+1,f.ctx),f.runtime);
}
for(const game of games.list.filter(game=>game.kind==='hundred'))test('actual '+game.id+' reserves before publishing cards and settles the same outcome',async()=>{
  const f=await fixture(game);await f.bet();f.events.length=0;
  await reveal(f);
  assert.equal(f.calls.filter(call=>call.method==='prePay').length,1);
  const revealIndex=f.events.indexOf('message:'+PUSH.SHOWDOWN_POKERS);
  assert.ok(revealIndex>f.events.indexOf('rpc:prePay'),'client sees final cards only after confirmed reservation');
  if(game.engine.applyCycle)await f.wallet.run(()=>game.engine.applyCycle(f.ctx.io,f.table,6),f.runtime);
  else await f.wallet.run(()=>game.engine.settleRound(f.ctx),f.runtime);
  assert.equal(f.calls.filter(call=>call.method==='prePay').length,1,'settlement reuses the reserved outcome');
  const reservation=f.calls.find(call=>call.method==='prePay'),settlement=f.calls.find(call=>call.method==='settlement');
  assert.equal(reservation.request.outcomeHash,settlement.request.outcomeHash);
  const report=JSON.parse(settlement.request.items.find(item=>item.userId===42).record).completedDisplayReport;
  assert.ok(report,'accepted financial result must retain the actual display report');
  assert.equal(report.agentId,7);assert.equal(report.userId,42);assert.equal(report.roomId,f.table.roomId);
  assert.equal(f.session.wallet,f.balances.get(42));
});

test('insufficient pool cannot publish a prepared final result or issue a payout',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm'));await f.bet();f.events.length=0;
  const invoke=f.common.finance;f.common.finance=(method,...args)=>method==='prePay'?{code:8,success:false,reason:'INSUFFICIENT_POOL'}:invoke(method,...args);
  await assert.rejects(()=>reveal(f),/INSUFFICIENT_POOL/);
  assert.equal(f.events.includes('message:'+PUSH.SHOWDOWN_POKERS),false);assert.equal(f.calls.some(call=>call.method==='settlement'),false);
});

test('actual wheel game wager, cancellation and zero/winning settlement use one financial lifecycle',async()=>{
  const game=games.list.find(game=>game.id==='arcade-bcbm'),f=await fixture(game),original=f.session.wallet;
  await f.bet();await f.wallet.run(()=>game.engine.cancelBets(f.ctx,{roomId:f.table.roomId,roomType:f.table.roomType,areaIds:[f.area]}),f.runtime);
  assert.equal(f.session.wallet,original);
  await f.bet();
  await f.wallet.run(()=>game.engine.settleRound(f.ctx),f.runtime);
  assert.deepEqual(f.calls.map(c=>c.method),['bet','cancelBet','bet','prePay','settlement']);
  assert.equal(f.session.wallet,f.balances.get(42));assert.equal(f.table.hand.settled,true);
  const final=f.session.wallet;
  await f.wallet.run(()=>game.engine.settleRound(f.ctx),f.runtime);assert.equal(f.session.wallet,final);
  assert.equal(f.calls.filter(c=>c.method==='settlement').length,1);
});

test('staged payouts cannot emit success without a complete Lottery settlement',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm')),before=f.session.wallet;
  await assert.rejects(()=>f.wallet.run(()=>{
    f.wallet.credit(f.session,100,{finance:{kind:'payout',table:f.table,round:{}}});
    f.wallet.deliver(()=>assert.fail('unconfirmed payout leaked to client'));
  },f.runtime),e=>e.code==='FINANCE_SETTLEMENT_MISSING');
  assert.equal(f.session.wallet,before);assert.equal(f.balances.get(42),before);assert.equal(f.calls.length,0);
});

test('cash and Lottery cannot mutate money in one action; no external write happens before rejection',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm')),before=f.session.wallet;
  await assert.rejects(()=>f.wallet.run(()=>{f.game.placeBet(f.ctx,{roomId:f.table.roomId,roomType:f.table.roomType,
    params:[{areaId:f.area,total:f.amount}]});f.wallet.debit(f.session,1);},f.runtime),e=>e.code==='FINANCE_ACTION_UNSUPPORTED');
  assert.equal(f.calls.length,0);assert.equal(f.session.wallet,before);assert.equal(f.table.playerBets.size,0);
});

test('missing pool level and removing a provider on hot reload cannot silently route financial writes',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm'));
  f.table.cfg.finance_level=null;
  await assert.rejects(()=>f.bet(),e=>e.code==='FINANCE_LEVEL_MISSING');assert.equal(f.calls.length,0);
  assert.throws(()=>f.wallet.configureLottery(f.wallet.lottery,[58]),/switch financial providers/);
  assert.equal(f.wallet.lotteryFor({roomType:19}),null,'ordinary cash tables retain their original provider');
});

test('Lottery balance corruption pauses the affected user and cannot be cleared by a new balance read',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm'));
  const invoke=f.common.finance;
  f.common.finance=async(...args)=>{const result=await invoke(...args);if(args[0]==='bet')f.balances.set(42,f.balances.get(42)+1);return result;};
  await assert.rejects(()=>f.bet(),e=>e.code==='FINANCE_BALANCE_MISMATCH');
  await assert.rejects(()=>f.bet(),e=>e.code==='CASH_CONFIRMATION_REQUIRED');
  assert.equal(f.calls.filter(call=>call.method==='bet').length,1);
});

test('real handler hot reload preserves wallet identity and an accepted Lottery round',async()=>{
  const f=await fixture(games.list.find(game=>game.id==='arcade-bcbm'));
  const runtime={...f.runtime,env:'prod',findConfig,hotVersion:'lottery-hot-before',config:{finance:{provider:'lottery',room_types:[53]}},
    rpc:{common:f.common,lobby:{async listFinanceGames(){return [{gameType:f.table.cfg.game_type,roomType:53,number:91053,symbol:'test-arcade-bcbm',state:1,isFrozen:0}];}}}};
  loadEnv({env:'prod'});
  try{
    await createHandler(runtime);const wallet=runtime.wallet;
    await f.bet();const id=f.calls.find(call=>call.method==='bet').request.roundId;
    runtime.hotVersion='lottery-hot-after';await createHandler(runtime);assert.equal(runtime.wallet,wallet);
    await f.bet();assert.equal(f.calls.filter(call=>call.method==='bet').at(-1).request.roundId,id);
    await f.wallet.run(()=>f.game.engine.settleRound(f.ctx),f.runtime);
    assert.equal(f.calls.find(call=>call.method==='settlement').request.roundId,id);
  }finally{loadEnv({env:'dev'});}
});
