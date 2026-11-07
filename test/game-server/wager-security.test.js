import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGames } from '../../game-server/src/games/catalog.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { createWallet } from '../../game-server/src/wallet/index.js';
import { createRegistry } from '../../game-server/src/registry.js';
import { SEND } from '../../game-server/src/messages.js';
import { scoreAmount, validWager, checkedTotal } from '../../game-server/src/core/wager.js';
import * as holdem from '../../game-server/src/games/holdem/engine.js';
import { OP } from '../../game-server/src/games/holdem/op.js';
import * as zjh from '../../game-server/src/games/zjh/engine.js';
import { ZJH_OP } from '../../game-server/src/games/zjh/messages.js';
import * as sgay from '../../game-server/src/games/sgay/engine.js';
import * as niuniu from '../../game-server/src/games/niuniu/engine.js';
import * as blackjack from '../../game-server/src/games/blackjack/engine.js';
import { transfer } from '../../game-server/src/games/mahjong/scoring.js';
import { comparison } from '../../game-server/src/games/sss/engine.js';

const games=await loadGames('all-wager-security'), rows=seedRooms();
const invalid=[-1,0,NaN,Infinity,-Infinity,1.5,Number.MAX_SAFE_INTEGER+1,true,[],{},'', '0x64','1e309'];
const covered=new Set();
async function fixture(game,row){
  const wallet=createWallet({mode:'local',local_balance:10000}),session={userId:70001,agentId:7,name:'tester'};
  await wallet.load(session);
  const table=game.createTable(row.game_room_config_id*10000+Number(row.room_index||0),row.room_type,row);table.agentId=7;
  const messages=[], io={env:'dev',wallet,broadcast:(id,data)=>messages.push({id,data}),
    sendUser:(uid,id,data)=>messages.push({uid,id,data}),forEachPlayer:fn=>fn(session),send(){}};
  const registry=createRegistry();registry.setTable(table.roomId,table,7,game.id);
  return {game,table,session,wallet,io,messages,registry,runtime:{env:'dev',wallet,configs:rows,registry,log:{error(){}}},
    send:(id,data)=>messages.push({id,data})};
}

test('common amount parser rejects malformed money and unsafe totals',()=>{
  for(const value of [-1,NaN,Infinity,-Infinity,1.5,true,false,[],[100],{},null,undefined,'',' ','0x10','1e3'])assert.ok(Number.isNaN(scoreAmount(value)));
  assert.equal(scoreAmount('1.10',100),110);assert.equal(scoreAmount(1.1,100),110);
  assert.ok(Number.isNaN(scoreAmount(1.0000000001)));assert.ok(Number.isNaN(scoreAmount(.0000000001,100)));
  assert.ok(Number.isNaN(scoreAmount(.001,100)));assert.ok(Number.isNaN(checkedTotal([Number.MAX_SAFE_INTEGER,1])));
  assert.equal(validWager(101,100),false);assert.equal(validWager(0,100),false);assert.equal(validWager(100,100),true);
});

for(const game of games.list.filter(game=>game.kind==='hundred')){
  const modes=[...new Map(rows.filter(row=>game.roomTypes.includes(Number(row.room_type)))
    .map(row=>[row.room_type+':'+row.play_mode,row])).values()];
  for(const row of modes)test('wager security '+game.id+' / '+row.room_type+' / mode '+row.play_mode,async()=>{
    covered.add(game.id);const f=await fixture(game,row),{table,session}=f;
    await game.onMessage(f,SEND.ENTER,{roomType:table.roomType,roomId:table.roomId,vipTableMode:1});
    if(game.engine?.beginRound)game.engine.beginRound(f.io,table,Date.now(),()=>.5);
    table.state=game.engine?.PHASE?.BETTING ?? game.betState();table.phaseEndsAt=Date.now()+60000;
    if(game.engine?.prepareHand && !table.preparedHand)game.engine.prepareHand(f.io,table);
    const options=game.betOptions(table),area=options.areas.find(area=>area.odds>0) || options.areas[0];
    assert.ok(area,'must choose a real enabled betting area');
    const before=structuredClone(table.totalBetsByArea);
    for(const malformed of [null,[],true,'bet'])assert.equal(await game.placeBet(f,malformed),false);
    for(const total of [...invalid,10001]){
      assert.equal(await game.placeBet(f,{roomType:table.roomType,roomId:table.roomId,params:[{areaId:area.areaId,total}]}),false,String(total));
      assert.equal(session.wallet,10000);assert.equal(table.playerBets.size,0);assert.deepEqual(table.totalBetsByArea,before);
    }
    assert.equal(await game.placeBet(f,{roomType:table.roomType,params:[{areaId:area.areaId,total:6000},{areaId:area.areaId,total:6000}]}),false,'batch total must fit wallet');
    const amount=options.minBet,factor=table.hand?.betReserveFactor || table.config.betBalanceFactor || 1;
    assert.equal(await game.placeBet(f,{roomType:table.roomType,params:[{areaId:area.areaId,total:amount}]}),true,'positive control must be accepted');
    assert.equal(session.wallet,10000-amount*factor);
    const reserve=session.wallet-amount*factor;
    assert.equal(f.wallet.reserveCarry(session,{uid:session.userId,point:0},{agentId:7,gameId:'holdem',roomType:19,roomId:999},reserve).ok,true);
    const balance=session.wallet;
    assert.equal(await game.placeBet(f,{roomType:table.roomType,params:[{areaId:area.areaId,total:amount*2}]}),false,'cannot spend reserved cash');
    assert.equal(session.wallet,balance);
    assert.equal(await game.placeBet(f,{roomType:table.roomType,params:[{areaId:area.areaId,total:amount}]}),true,'exact free balance may be used');
    assert.equal(session.wallet,session.carryAmount);
  });
}

test('holdem invalid and unaffordable raises never clamp into a real bet',async()=>{
  covered.add('holdem');const table=holdem.createTexasTable(700000,19,{small_blind:10,big_blind:20,carry_min:500});
  table.members=[{uid:1,pos:0,point:1000,streetBet:20,totalBet:20,hole:[0,1]},{uid:2,pos:1,point:1000,streetBet:20,totalBet:20,hole:[2,3]}];
  table.phase='playing';table.hand={currentBet:20,minRaise:20,pot:40,actorUid:1,street:'BET_FLOP',board:[4,5,6],acted:new Set(),participants:table.members};
  const io={broadcast(){},sendUser(){},forEachPlayer(){}};
  for(const amount of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER,11,[],{},true,'0x10',.001]){
    holdem.onTexasAction(io,table,{userId:1},{operation:OP.ADD,operationData:amount});
    assert.equal(table.hand.pot,40);assert.equal(table.members[0].point,1000);assert.equal(table.hand.actorUid,1);
  }
  holdem.onTexasAction(io,table,{userId:1},{operation:999,operationData:0});assert.equal(table.hand.actorUid,1);
  holdem.onTexasAction(io,table,{userId:1},{operation:OP.ADD,operationData:1});
  assert.equal(table.members[0].point,920);assert.equal(table.members[0].streetBet,100);
});

test('zjh rejects invalid client amounts before changing chips or turn',async()=>{
  covered.add('zjh');const game=games.list.find(game=>game.id==='zjh'),row=rows.find(row=>row.room_type===25),f=await fixture(game,row);
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];zjh.beginHand(f.io,f.table);
  const actor=f.table.members.find(p=>p.uid===f.table.hand.actorUid),before=actor.point,pot=f.table.hand.pot;
  for(const amount of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER,1000,[],{},true]){
    assert.equal(zjh.onZjhAction(f.io,f.table,{userId:actor.uid},{operation:ZJH_OP.RAISE,operationData:amount}),false);
    assert.equal(actor.point,before);assert.equal(f.table.hand.pot,pot);
  }
  const legal=zjh.actionOptions(f.table,actor).find(op=>op.operation===ZJH_OP.RAISE).data.score;
  assert.equal(zjh.onZjhAction(f.io,f.table,{userId:actor.uid},{operation:ZJH_OP.RAISE,operationData:legal/100}),true);
  assert.equal(actor.point,before-legal);
});

test('sgay multiplier cannot spend more than current seat chips',async()=>{
  covered.add('sgay');const game=games.list.find(game=>game.id==='sgay'),f=await fixture(game,rows.find(row=>row.room_type===32));
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];sgay.begin(f.io,f.table);
  f.table.hand.stage='bet';f.table.hand.deadline=Date.now()+60000;const p=f.table.hand.players[0];p.member.point=f.table.ante;
  for(const multiple of [-1,0,2,NaN,Infinity,Number.MAX_SAFE_INTEGER,true,'1',[],{}]){assert.equal(sgay.bet(f.io,f.table,p.uid,multiple),false);assert.equal(p.bet,null);assert.equal(p.member.point,f.table.ante);}
  assert.equal(sgay.bet(f.io,f.table,p.uid,1),true);assert.equal(p.member.point,0);
});

test('niuniu multiplier validates the resulting stake against current chips',async()=>{
  covered.add('niuniu');const game=games.list.find(game=>game.id==='niuniu'),f=await fixture(game,rows.find(row=>row.room_type===24));
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];niuniu.begin(f.io,f.table);
  f.table.hand.stage='bet';f.table.hand.bankerUid=2;f.table.hand.bankerMultiple=2;const p=f.table.hand.players.find(p=>p.uid===1);p.member.point=0;
  for(const multiple of [-1,0,1,NaN,Infinity,Number.MAX_SAFE_INTEGER,true,'1',[],{}]){assert.equal(niuniu.bet(f.io,f.table,1,multiple),false);assert.equal(p.bet,null);}
  const multiple=f.table.roomRules.bettingMultiples[0];p.member.point=f.table.ante*2*multiple;
  assert.equal(niuniu.bet(f.io,f.table,1,multiple),true);
});

for(const mode of [0,1])test('blackjack mode '+mode+' rejects negative, malformed and over-balance bets',async()=>{
  covered.add('blackjack');const game=games.list.find(game=>game.id==='blackjack'),row=rows.find(row=>row.room_type===31&&Number(row.play_mode)===mode),f=await fixture(game,row);
  f.table.members=[{uid:1,pos:0,point:10000}];blackjack.begin(f.io,f.table);
  for(const betAmount of [...invalid,10001]){assert.equal(blackjack.act(f.io,f.table,1,4501,{betAmount,targetPos:mode===1?1:undefined}),false);assert.equal(f.table.members[0].point,10000);assert.equal(f.table.hand.players[0].mainBet,0);}
  assert.equal(blackjack.act(f.io,f.table,1,4501,{betAmount:f.table.ante,targetPos:mode===1?1:undefined}),true);
  assert.equal(f.table.members[0].point,10000-f.table.ante);
});

for(const game of games.list.filter(game=>game.kind==='slots'))test('scratch '+game.id+' validates denomination and full request cost before service',async()=>{
  covered.add(game.id);const f=await fixture(game,rows.find(row=>game.roomTypes.includes(Number(row.room_type))));let calls=0;
  f.runtime.scratchTickets={async reveal(){calls++;return {code:0};},async purchase(){calls++;return {code:0};}};
  for(const faceValue of [...invalid,100000]){await game.onMessage(f,3701,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue});assert.notEqual(f.messages.at(-1).data.code,0);}
  assert.equal(calls,0);assert.equal(f.session.wallet,10000);
  await game.onMessage(f,3704,{purchaseMode:'FULL_BOOK',bookId7List:['test-book'],faceValue:1000});assert.notEqual(f.messages.at(-1).data.code,0);assert.equal(calls,0);
  await game.onMessage(f,3701,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100});assert.equal(calls,1);
});

test('mahjong money is server-derived and transfers reject invalid amounts or cap liability',()=>{
  covered.add('mahjong');const player=uid=>({uid,pos:uid,openingPoint:100,member:{point:100},delta:0,details:[]});
  for(const amount of [-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]){const from=player(1),to=player(2);assert.throws(()=>transfer([{from,to,amount}]),/Invalid mahjong/);assert.equal(from.member.point,100);assert.equal(to.member.point,100);}
  const from=player(1),to=player(2);transfer([{from,to,amount:100000}]);assert.equal(from.member.point,0);assert.equal(to.member.point,200);
});

test('sss server-computed settlement caps losses to opening chips',()=>{
  covered.add('sss');const p=(uid,value)=>({uid,openingPoint:3,result:{isWater:false,hasSpecialType:false,hasHorseCard:false,frontHand:{key:[0,value],water:1},middleHand:{key:[0,value],water:1},backHand:{key:[0,value],water:1}}});
  const players=[p(1,14),p(2,13),p(3,12),p(4,11)],result=comparison({ante:100000,hand:{players}});
  assert.equal(Object.values(result.scoreMap).reduce((sum,n)=>sum+n,0),0);for(const p of players)assert.ok(p.openingPoint+result.scoreMap[p.uid]>=0);
});

test('every registered game implementation has a wager or fixed-liability security check',()=>{
  assert.deepEqual(games.list.map(game=>game.id).filter(id=>!covered.has(id)),[]);
});
