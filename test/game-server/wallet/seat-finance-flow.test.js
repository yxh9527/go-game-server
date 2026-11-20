import test from 'node:test';
import assert from 'node:assert/strict';
import {seatFinanceAuthority,signedFinanceScore} from '../../fixtures/seat-finance-authority.js';
import {moneyToScore} from '../../../game-server/src/wallet/round-finance.js';
import {loadGames} from '../../../game-server/src/games/catalog.js';
import {seedRooms} from '../../../cache/rpc/seed.js';
import {createRegistry} from '../../../game-server/src/registry.js';
const {createAuthoritativeWallet}=await importHotModule(new URL('../../../game-server/src/wallet/authoritative.js',import.meta.url).href,'wallet-controller-regression');
const {createRoundFinance}=await importHotModule(new URL('../../../game-server/src/wallet/round-finance.js',import.meta.url).href,'seat-controller-regression');
import {createGameRouteIndex} from '../../../shared/rpc/game-routes.js';
import {importHotModule} from '../../../shared/hot-import.js';
const [holdem,zjh,sgay,blackjack,niuniu,sss,mahjong]=await Promise.all(
  ['holdem','zjh','sgay','blackjack','niuniu','sss','mahjong'].map(game=>importHotModule(new URL('../../../game-server/src/games/'+game+'/engine.js',import.meta.url).href,'seat-finance-engines')));
import {transfer} from '../../../game-server/src/games/mahjong/scoring.js';
import {OP} from '../../../game-server/src/games/holdem/op.js';
import {ZJH_OP} from '../../../game-server/src/games/zjh/messages.js';
import {SEND as BJ_SEND} from '../../../game-server/src/games/blackjack/messages.js';
import {evaluate as evaluateSgay} from '../../../game-server/src/games/sgay/hand.js';
import {installUserCenter} from '../../../game-server/src/core/user-center.js';

const games=await loadGames('seat-finance'),configs=seedRooms();
async function fixture(type,count,patch={}){
  const game=games.byRoomType.get(type),row={...configs.find(c=>Number(c.room_type)===type),finance_level:1,...patch};
  const table=game.createTable(Number(row.game_room_config_id)*10000,type,row);table.agentId=7;
  count??=table.roomRules?.gameStartNum||2;
  const authority=seatFinanceAuthority(),wallet=createAuthoritativeWallet({common:authority.common}),registry=createRegistry(),sessions=[];
  registry.setTable(table.roomId,table,7,game.id);
  const runtime={env:'prod',wallet,registry,log:{error(){}}};
  wallet.configureLottery(createRoundFinance(authority.common,{routes:createGameRouteIndex([{gameType:row.game_type,roomType:type,number:92000+type,symbol:'test-seat-'+type,state:1,isFrozen:0}])}),[type]);
  for(let i=0;i<count;i++){
    const uid=42+i;authority.add(uid);const session={userId:uid,agentId:7,currency:'CNY',authenticated:true,roomId:table.roomId,gameId:game.id};
    registry.bind({},session);sessions.push(session);await wallet.load(session);
    const member={uid,pos:i,point:0,name:'test-'+uid,state:2,bot:false};table.members.push(member);
    await wallet.run(()=>wallet.reserveCarry(session,member,table,10000),runtime);
  }
  const messages=[],send=(id,data)=>wallet.deliver(()=>messages.push({id,data:structuredClone(data)}));
  const io={env:'prod',wallet,broadcast:send,send:(_ws,id,data)=>send(id,data),sendUser:(_uid,id,data)=>send(id,data),forEachPlayer:fn=>sessions.forEach(fn),sessionFor:uid=>sessions.find(s=>s.userId===uid)};
  return {type,game,table,wallet,runtime,sessions,authority,messages,io,run:fn=>wallet.run(fn,runtime)};
}

test('Jinhua repeated authoritative buy-in and post-hand stand clears the original carry each round',async()=>{
  const f=await fixture(25),session=f.sessions[0];
  for(let cycle=0;cycle<12;cycle++){
    if(cycle){
      await f.run(()=>{
        const member=f.game.sit(f.table,session,{wallet:f.wallet},{buyIn:0,pos:0});assert.ok(member);
        f.game.onCarryScore({runtime:f.runtime,table:f.table,session,body:{carryIn:100},io:f.io,send(){}});
        assert.equal(member.point,10000);
      });
    }
    const member=f.table.members.find(m=>m.uid===session.userId);member.standAfterRound=true;
    await f.run(()=>zjh.beginHand(f.io,f.table));
    assert.ok(f.table.hand,JSON.stringify({cycle,members:f.table.members.map(m=>({uid:m.uid,point:m.point,folded:m.folded,state:m.state})),carry:f.wallet.carryRecord(session)}));
    const actor=f.sessions.find(s=>s.userId===f.table.hand.actorUid);
    await f.run(()=>zjh.onZjhAction(f.io,f.table,actor,{operation:ZJH_OP.FOLD}));
    await f.run(()=>f.game.afterRound({runtime:f.runtime,table:f.table,session,io:f.io}));
    assert.equal(f.table.members.includes(member),false,'seat retained '+cycle);
    assert.equal(f.wallet.carryRecord(session),null,'carry retained '+cycle);
    assert.ok(f.messages.filter(m=>m.id===9212).every(m=>Number.isFinite(m.data)),'post-hand balance must be numeric');
    // Keep the other player's funds sufficient without changing wallet money.
    const other=f.table.members.find(m=>m.uid!==session.userId);
    if(!other)await f.run(()=>{const s=f.sessions[1],m=f.game.sit(f.table,s,{wallet:f.wallet},{buyIn:0,pos:1});f.wallet.reserveCarry(s,m,f.table,10000);});
  }
});

for(const type of [19,25])test(type+': actual forced wagers, fold settlement and cash-out use one authoritative seat balance',async()=>{
  const f=await fixture(type);
  await f.run(()=>type===19?holdem.beginHand(f.io,f.table):zjh.beginHand(f.io,f.table));
  assert.ok(f.authority.calls.some(c=>c.method==='bet'));assert.ok(f.table.hand);
  const hand=f.table.hand,actor=f.sessions.find(s=>s.userId===hand.actorUid);
  await f.run(()=>type===19?holdem.onTexasAction(f.io,f.table,actor,{operation:OP.ABANDON,operationData:0}):zjh.onZjhAction(f.io,f.table,actor,{operation:ZJH_OP.FOLD}));
  assert.equal(f.table.hand,null);
  const final=f.authority.calls.find(c=>c.method==='settlement');assert.ok(final);
  assert.equal(final.request.mode,'NORMAL');assert.ok(final.request.items.every(i=>i.carry?.token));
  for(const session of f.sessions){const member=f.table.members.find(m=>m.uid===session.userId);assert.equal(session.wallet,f.authority.account(session.userId).balance);assert.equal(member.point,f.authority.account(session.userId).carry.amount);}
  assert.equal(f.sessions.reduce((sum,s)=>sum+s.wallet,0),200000,'heads-up fold conserves funded money');
  for(const session of f.sessions){const member=f.table.members.find(m=>m.uid===session.userId),balance=session.wallet;
    await f.run(()=>f.wallet.releaseCarry(session,member));assert.equal(session.wallet,balance);assert.equal(f.authority.account(session.userId).carry,null);}
  assert.ok(f.authority.cashCalls.every(c=>c.steps.every(s=>['reserve','release','renew'].includes(s.kind))));
});

test('the unified settlement carries the real completed holdem report before asynchronous delivery',async()=>{
 const f=await fixture(19);f.runtime.gateway={writeUserCenter:async()=>{throw Error('record delivery unavailable')}};installUserCenter(f.runtime);
 await f.run(()=>holdem.beginHand(f.io,f.table));const actor=f.sessions.find(s=>s.userId===f.table.hand.actorUid);
 await f.run(()=>holdem.onTexasAction(f.io,f.table,actor,{operation:OP.ABANDON,operationData:0}));
 const settlement=f.authority.calls.find(c=>c.method==='settlement');assert.ok(settlement);
 for(const item of settlement.request.items){
  const data=JSON.parse(item.record),report=data.completedDisplayReport;
  assert.equal(report.userId,item.userId);assert.equal(report.agentId,7);assert.equal(report.roomId,f.table.roomId);assert.equal(report.roomType,19);
  assert.ok(report.detail.replay);assert.equal(report.detail.replay.currentInningNum,1);
  const original=[...f.runtime.userCenterState.outgoing.values()].find(r=>r.userId===item.userId);assert.ok(original);assert.equal(report.id,original.id);
  assert.deepEqual(report.detail.replay,JSON.parse(JSON.stringify(original.detail.replay)));
  for(const opponent of report.detail.replay.firstGameList.filter(p=>p.uid!==item.userId)){
    const publicResult=original.detail.firstGameList.find(p=>p.uid===opponent.uid);
    assert.deepEqual(opponent.showCards,publicResult.showCards?.length?publicResult.showCards:[-1,-1]);
  }
 }
 assert.equal(f.runtime.userCenterState.outgoing.size,2,'failed asynchronous delivery must not erase final records');
});

test('AOF fixed auto wager and showdown use the original carry-bound Bet and Settlement once',async()=>{
 const f=await fixture(19,3,{play_mode:8,aof_bet:100,initial_bet:0,carry_min:100});
 await f.run(()=>holdem.beginHand(f.io,f.table));assert.equal(f.table.hand.pot,300);
 assert.ok(f.authority.calls.filter(c=>c.method==='bet').every(c=>c.request.items.every(i=>i.amount==='1.00')));
 for(let i=0;i<4;i++)await f.run(()=>holdem.tickPlaying(f.io,f.table,f.table.hand.aofNextAt));
 assert.equal(f.table.hand,null);const settlements=f.authority.calls.filter(c=>c.method==='settlement');assert.equal(settlements.length,1);
 assert.ok(settlements[0].request.items.every(i=>i.betAmount==='1.00'&&i.carry?.token));
 assert.equal(f.sessions.reduce((sum,s)=>sum+s.wallet,0),300000);
 for(const session of f.sessions){const member=f.table.members.find(m=>m.uid===session.userId);assert.equal(member.point,f.authority.account(session.userId).carry.amount);assert.equal(session.wallet,f.authority.account(session.userId).balance);}
 assert.ok(f.authority.cashCalls.every(c=>c.steps.every(s=>['reserve','release','renew'].includes(s.kind))));
});

test('actual three-public-card game settles original wagers and credits each carry once',async()=>{
  const f=await fixture(32,3);await f.run(()=>sgay.begin(f.io,f.table,1000));
  for(let i=0;i<5&&f.table.hand;i++)await f.run(()=>sgay.tick(f.io,f.table,f.table.hand.deadline));
  assert.equal(f.table.hand,null);assert.equal(f.authority.calls.filter(c=>c.method==='settlement').length,1);
  for(const s of f.sessions)assert.equal(f.table.members.find(m=>m.uid===s.userId).point,f.authority.account(s.userId).carry.amount);
});

test('Sgay triple bonus extra losses are recorded as actual additional wagers before final settlement',async()=>{
 const f=await fixture(32,3);await f.run(()=>sgay.begin(f.io,f.table,1000));
 const hand=f.table.hand;hand.players[0].hole=[0,13,26];hand.players[0].result=evaluateSgay(hand.players[0].hole);
 for(let i=1;i<hand.players.length;i++){hand.players[i].hole=[i,13+i,27+i];hand.players[i].result=evaluateSgay(hand.players[i].hole);}
 for(let i=0;i<5&&f.table.hand;i++)await f.run(()=>sgay.tick(f.io,f.table,f.table.hand.deadline));
 assert.equal(f.table.hand,null);const final=f.authority.calls.find(c=>c.method==='settlement');assert.ok(final);
 for(const uid of [42,43,44]){const bets=f.authority.calls.filter(c=>c.method==='bet').flatMap(c=>c.request.items).filter(item=>item.userId===uid).reduce((n,item)=>n+moneyToScore(item.amount),0);
  const item=final.request.items.find(item=>item.userId===uid);assert.equal(moneyToScore(item.betAmount),bets);assert.equal(f.table.members.find(m=>m.uid===uid).point,f.authority.account(uid).carry.amount);}
 assert.ok(f.authority.calls.filter(c=>c.method==='bet').length>3);assert.equal(f.sessions.reduce((n,s)=>n+s.wallet,0)+f.table.taxCollected,300000);
});

test('actual blackjack raw-score wager settles insurance/hands into the same seat reservation',async()=>{
  const f=await fixture(31,1);await f.run(()=>blackjack.begin(f.io,f.table,1000));
  await f.run(()=>blackjack.act(f.io,f.table,42,BJ_SEND.BET,{betAmount:100},1001));
  for(let i=0;i<80&&!f.table.hand?.settled;i++)await f.run(()=>blackjack.tick(f.io,f.table,f.table.hand.deadline));
  assert.ok(f.table.hand?.settled);assert.equal(f.authority.calls.filter(c=>c.method==='settlement').length,1);
  assert.equal(f.table.members[0].point,f.authority.account(42).carry.amount);
});

for(const type of [24,27,26,28,30])test(type+': actual net-score game records abs(profit) and transfers money only once',async()=>{
  const f=await fixture(type);
  const engine=type===24?niuniu:type===27?sss:mahjong;
  await f.run(()=>engine.begin(f.io,f.table,1000));assert.ok(f.table.hand);
  assert.ok(f.authority.calls.filter(c=>c.method==='bet').every(c=>c.request.items.every(item=>item.amount==='0.00')));
  assert.ok(f.sessions.every(s=>s.wallet===100000),'participant registration must not debit a fictitious wager');
  if([26,28,30].includes(type)){
    const [from,to]=f.table.hand.players;
    const beforeFrom=from.member.point,beforeTo=to.member.point;
    await f.run(()=>transfer([{from,to,amount:123}],5,'test transfer'));
    assert.equal(f.sessions[0].wallet,100000,'funded room transfers remain reserved until the complete round settles');
    assert.equal(from.member.point,beforeFrom-123);assert.equal(to.member.point,beforeTo+123);
    await f.run(()=>engine.settle(f.io,f.table));
  }else for(let step=0;step<10&&f.table.hand&&!f.authority.calls.some(c=>c.method==='settlement');step++)
    await f.run(()=>engine.tick(f.io,f.table,f.table.hand.deadline));
  const settlements=f.authority.calls.filter(c=>c.method==='settlement');assert.equal(settlements.length,1);
  assert.equal(settlements[0].request.mode,'SEAT_NET');
  for(const item of settlements[0].request.items){
    const effective=moneyToScore(item.betAmount),net=signedFinanceScore(item.netScore);
    assert.equal(effective,Math.abs(net));
    const session=f.sessions.find(s=>s.userId===item.userId),member=f.table.members.find(m=>m.uid===item.userId);
    assert.equal(session.wallet,100000+net,'effective bet statistics cannot be debited as money');
    assert.equal(member.point,10000+net);assert.equal(member.point,f.authority.account(item.userId).carry.amount);
  }
});

test('mid-hand carry top-ups are not winnings and net transfers survive distinct business actions',async()=>{
  const f=await fixture(28);await f.run(()=>mahjong.begin(f.io,f.table,1000));
  const [from,to]=f.table.hand.players,session=f.sessions.find(s=>s.userId===from.uid);
  const before=from.member.point;
  await f.run(()=>f.wallet.reserveCarry(session,from.member,f.table,500));
  assert.equal(from.member.point,before+500);assert.equal(session.wallet,100000);
  await f.run(()=>transfer([{from,to,amount:200}],5,'test'));
  await f.run(()=>transfer([{from:to,to:from,amount:50}],5,'test'));
  assert.equal(session.wallet,100000);
  await f.run(()=>mahjong.settle(f.io,f.table));
  const final=f.authority.calls.find(c=>c.method==='settlement'),item=final.request.items.find(i=>i.userId===from.uid),net=signedFinanceScore(item.netScore);
  assert.equal(session.wallet,100000+net);assert.equal(from.member.point,10500+net);
  const walletBalance=session.wallet;await f.run(()=>f.wallet.releaseCarry(session,from.member));
  assert.equal(session.wallet,walletBalance,'releasing reserved chips must not pay the top-up or winnings twice');
});

test('the final settlement and immediate release of a departing funded seat preserve operation order',async()=>{
  const f=await fixture(19);await f.run(()=>holdem.beginHand(f.io,f.table));
  const actor=f.sessions.find(s=>s.userId===f.table.hand.actorUid),member=f.table.members.find(m=>m.uid===actor.userId);
  await f.run(()=>{
    holdem.onTexasAction(f.io,f.table,actor,{operation:OP.ABANDON,operationData:0});
    f.wallet.releaseCarry(actor,member);
  });
  assert.equal(f.authority.account(actor.userId).carry,null);
  const item=f.authority.calls.find(c=>c.method==='settlement').request.items.find(i=>i.userId===actor.userId);
  assert.equal(actor.wallet,100000+signedFinanceScore(item.profit));
});

test('a committed SEAT_NET timeout retries the original settlement without another transfer',async()=>{
  const f=await fixture(24);await f.run(()=>niuniu.begin(f.io,f.table,1000));
  const invoke=f.authority.common.finance;let lost=false;
  f.authority.common.finance=async(...args)=>{const result=await invoke(...args);if(args[0]==='settlement'&&!lost){lost=true;throw Object.assign(new Error('lost acknowledgment'),{code:4});}return result;};
  for(let step=0;step<10&&f.table.hand;step++)await f.run(()=>niuniu.tick(f.io,f.table,f.table.hand.deadline));
  const commands=f.authority.calls.filter(c=>c.method==='settlement');assert.equal(commands.length,2);assert.deepEqual(commands[0].request,commands[1].request);
  assert.ok(f.authority.calls.some(c=>c.method==='getRoundFinanceState'));
  for(const item of commands[0].request.items)assert.equal(f.authority.account(item.userId).balance,100000+signedFinanceScore(item.netScore));
});
