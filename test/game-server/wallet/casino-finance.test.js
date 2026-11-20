import test from 'node:test';
import assert from 'node:assert/strict';
import {seatFinanceAuthority,signedFinanceScore} from '../../fixtures/seat-finance-authority.js';
import {createRegistry} from '../../../game-server/src/registry.js';
import {createAuthoritativeWallet} from '../../../game-server/src/wallet/authoritative.js';
import {createRoundFinance} from '../../../game-server/src/wallet/round-finance.js';
import {createGameRouteIndex} from '../../../shared/rpc/game-routes.js';
import {BlackjackGame} from '../../../game-server/src/games/blackjack/BlackjackGame.js';
import * as engine from '../../../game-server/src/games/blackjack/engine.js';
import * as bank from '../../../game-server/src/games/blackjack/banker.js';
import * as casino from '../../../game-server/src/games/blackjack/casino.js';
import {SEND} from '../../../game-server/src/games/blackjack/messages.js';
import {installUserCenter} from '../../../game-server/src/core/user-center.js';

for(const withBanker of [false,true])test('casino unified wagers and settlement, banker='+withBanker,async()=>{
 const game=new BlackjackGame(),table=game.createTable(31010000,31,{game_type:31,room_type:31,play_mode:1,ante:100,carry_min:0,finance_level:1,game_room_config_id:3101});table.agentId=7;
 const authority=seatFinanceAuthority(),registry=createRegistry(),wallet=createAuthoritativeWallet({common:authority.common}),runtime={env:'prod',registry,wallet,config:{finance:{banker_net:true}},log:{error(){}}};registry.setTable(table.roomId,table,7,game.id);
 wallet.configureLottery(createRoundFinance(authority.common,{routes:createGameRouteIndex([{gameType:31,roomType:31,number:92031,symbol:'casino-bj',state:1,isFrozen:0}])}),[31],runtime);
 installUserCenter(runtime);
 const sessions=new Map();for(const uid of [42,43]){authority.add(uid,1000000);const session={userId:uid,agentId:7,currency:'CNY',authenticated:true,roomId:table.roomId,gameId:game.id};registry.bind({},session);sessions.set(uid,session);await wallet.load(session)}
 const io={env:'prod',wallet,broadcast(){},send(){},sendUser(){},forEachPlayer:fn=>sessions.forEach(fn),sessionFor:uid=>sessions.get(uid)},run=fn=>wallet.run(fn,runtime),ctx=uid=>({runtime,table,session:sessions.get(uid),io,send(){}});
 const member={uid:43,pos:0,point:0,name:'player',bot:false,state:2};table.members.push(member);casino.bindWalletSeat(member,sessions.get(43));
 if(withBanker){
  await run(()=>bank.request(ctx(42),4509,{bankerType:1,amount:20000,maxWinLoseAmount:10000,bankerCount:10}));table.phase='starting';table.startAt=0;await run(()=>bank.flush(ctx(42)));
  assert.equal(authority.account(42).balance,1000000);assert.equal(authority.account(42).carry.amount,20000);
 }
 await run(()=>engine.begin(io,table));assert.ok(table.hand);
 await run(()=>engine.act(io,table,43,SEND.BET,{betAmount:100,targetPos:1,pairAmount:0,notPairAmount:0}));
 assert.equal(authority.account(43).balance,999900);assert.equal(member.point,0);
 for(let i=0;i<100&&!table.hand.settled;i++)await run(()=>engine.tick(io,table,table.hand.deadline));
 assert.equal(table.hand.settled,true);const result=table.hand.results.find(r=>r.uid===43),settlement=authority.calls.find(c=>c.method==='settlement');assert.ok(settlement);
 assert.equal(settlement.request.mode,withBanker?'BANKER_NET':'NORMAL');assert.equal(member.point,0);assert.equal(authority.account(43).balance,1000000+result.score);
 assert.ok(JSON.parse(settlement.request.items.find(i=>i.userId===43).record).completedDisplayReport);
 assert.equal(sessions.get(43).wallet,authority.account(43).balance);
 const before=authority.calls.filter(c=>c.method==='settlement').length;await run(()=>engine.settle(io,table));assert.equal(authority.calls.filter(c=>c.method==='settlement').length,before);
 if(withBanker){const item=settlement.request.items.find(i=>i.userId===42),net=signedFinanceScore(item.netScore);assert.equal(authority.account(42).carry.amount,20000+net);
  await run(()=>bank.request(ctx(42),4510,{bankerType:1}));await run(()=>engine.tick(io,table,table.hand.deadline));table.startAt=0;
  await run(()=>bank.flush(ctx(42)));assert.equal(authority.account(42).carry,null);assert.equal(authority.account(42).balance,1000000+net);
 }
});
