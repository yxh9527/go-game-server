import test from 'node:test';
import assert from 'node:assert/strict';
import {loadGames} from '../../game-server/src/games/catalog.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {createWallet} from '../../game-server/src/wallet/index.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {SEND} from '../../game-server/src/messages.js';
import * as holdem from '../../game-server/src/games/holdem/engine.js';
import {OP} from '../../game-server/src/games/holdem/op.js';
import * as zjh from '../../game-server/src/games/zjh/engine.js';
import {ZJH_OP} from '../../game-server/src/games/zjh/messages.js';
import * as niuniu from '../../game-server/src/games/niuniu/engine.js';
import * as sgay from '../../game-server/src/games/sgay/engine.js';
import * as blackjack from '../../game-server/src/games/blackjack/engine.js';
import {STATE} from '../../game-server/src/games/blackjack/messages.js';

const games=await loadGames('wager-phase-checks'),rows=seedRooms(),covered=new Set();
async function fixture(game,row){
  const wallet=createWallet({mode:'local',local_balance:10000}),session={userId:77001,agentId:7,name:'phase'};await wallet.load(session);
  const table=game.createTable(Number(row.game_room_config_id)*10000+Number(row.room_index||0),Number(row.room_type),row);table.agentId=7;
  const messages=[],io={env:'dev',wallet,broadcast:(id,data)=>messages.push({id,data}),sendUser:(uid,id,data)=>messages.push({uid,id,data}),send(){},forEachPlayer:fn=>fn(session)};
  const registry=createRegistry();registry.setTable(table.roomId,table,7,game.id);
  return {game,table,session,wallet,io,messages,send:(id,data)=>messages.push({id,data}),runtime:{env:'dev',wallet,registry,configs:rows,log:{error(){}}}};
}

for(const game of games.list.filter(g=>g.kind==='hundred')){
  const variants=[...new Map(rows.filter(r=>game.roomTypes.includes(Number(r.room_type))).map(r=>[r.room_type+':'+r.play_mode,r])).values()];
  for(const row of variants)test('phase gate '+game.id+' / '+row.room_type+' / '+row.play_mode,async t=>{
    const clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add(game.id);
    const f=await fixture(game,row),{table,session}=f;await game.onMessage(f,SEND.ENTER,{roomType:table.roomType,roomId:table.roomId,vipTableMode:1});
    if(game.engine?.beginRound)game.engine.beginRound(f.io,table,clock,()=>.5);
    const betting=game.engine?.PHASE?.BETTING ?? game.betState();table.state=betting;table.phaseEndsAt=clock+10000;
    if(game.engine?.prepareHand&&!table.preparedHand)game.engine.prepareHand(f.io,table);
    const options=game.betOptions(table),area=options.areas.find(a=>a.odds>0)||options.areas[0];
    const request={roomType:table.roomType,roomId:table.roomId,state:betting,phase:'bet',params:[{areaId:area.areaId,total:options.minBet}]};
    const totals=structuredClone(table.totalBetsByArea);
    const denied=async()=>{assert.equal(await game.placeBet(f,request),false);assert.equal(session.wallet,10000);assert.equal(table.playerBets.size,0);assert.deepEqual(table.totalBetsByArea,totals);};
    const states=new Set([0,1,3,4,5,6,7,8,9,10,...Object.values(game.engine?.PHASE||{}),...(game.phasesFor?.(table)||[]).map(p=>p.state)]);
    for(const state of states)if(state!==betting){table.state=state;await denied();}
    table.state=betting;for(const deadline of [clock-1,clock,0,NaN,Infinity]){table.phaseEndsAt=deadline;await denied();}
    table.phaseEndsAt=clock+10000;table.closing=true;await denied();table.closing=false;
    if(table.hand){for(const key of ['settled','settling','cancelTask']){table.hand[key]=true;await denied();delete table.hand[key];}}
    else {table.hundredCycleTask=Promise.resolve();await denied();delete table.hundredCycleTask;}
    assert.equal(await game.placeBet(f,request),true,'a real wager inside its active window must still work');
  });
}

test('holdem permits only active betting streets before the actor deadline',t=>{
  let clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add('holdem');
  const make=()=>{
    const table=holdem.createTexasTable(700000,19,{small_blind:10,big_blind:20,carry_min:500});
    table.members=[{uid:1,pos:0,point:1000,streetBet:20,totalBet:20,hole:[0,1]},{uid:2,pos:1,point:1000,streetBet:20,totalBet:20,hole:[2,3]}];
    table.phase='playing';table.hand={street:'BET_FLOP',deadline:clock+1000,currentBet:20,minRaise:20,pot:40,actorUid:1,board:[4,5,6],acted:new Set(),participants:table.members};return table;
  };
  const io={broadcast(){},sendUser(){},forEachPlayer(){}},body={operation:OP.ADD,operationData:1};
  const denied=table=>{holdem.onTexasAction(io,table,{userId:1},body);assert.equal(table.members[0].point,1000);assert.equal(table.hand.pot,40);assert.equal(table.hand.actorUid,1);};
  for(const phase of ['idle','starting','settled','closed']){const table=make();table.phase=phase;denied(table);}
  for(const street of ['NONE','DEAL','SHOWDOWN','SETTLE','ENDED']){const table=make();table.hand.street=street;denied(table);}
  for(const deadline of [clock-1,clock,0,NaN,Infinity]){const table=make();table.hand.deadline=deadline;denied(table);}
  for(const flag of ['folded','allIn']){const table=make();table.members[0][flag]=true;denied(table);}
  const closed=make();closed.closing=true;denied(closed);
  for(const street of ['BET_PERFLOP','BET_FLOP','BET_TURN','BET_RIVER']){const table=make();table.hand.street=street;table.hand.deadline=clock+1;holdem.onTexasAction(io,table,{userId:1},body);assert.equal(table.members[0].point,920);}
});

test('zjh refuses closed phases, expired turns and comparison animation requests',async t=>{
  const clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add('zjh');
  const game=games.list.find(g=>g.id==='zjh'),f=await fixture(game,rows.find(r=>r.room_type===25));
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];zjh.beginHand(f.io,f.table);
  const hand=f.table.hand,actor=f.table.members.find(p=>p.uid===hand.actorUid),score=zjh.actionOptions(f.table,actor).find(o=>o.operation===ZJH_OP.RAISE).data.score;
  const point=actor.point,pot=hand.pot,body={operation:ZJH_OP.RAISE,operationData:score/100};
  const denied=()=>{assert.equal(zjh.onZjhAction(f.io,f.table,{userId:actor.uid},body),false);assert.equal(actor.point,point);assert.equal(hand.pot,pot);};
  for(const phase of ['idle','starting','settled','closed']){f.table.phase=phase;denied();}f.table.phase='playing';
  for(const deadline of [clock-1,clock,NaN,Infinity]){hand.deadline=deadline;denied();}hand.deadline=clock+1000;
  hand.comparisonPause={until:clock+500};denied();delete hand.comparisonPause;
  f.table.closing=true;denied();f.table.closing=false;
  assert.equal(zjh.onZjhAction(f.io,f.table,{userId:actor.uid},body),true);assert.equal(actor.point,point-score);
});

test('niuniu opens grab and wager requests only in their own timed stages',async t=>{
  const clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add('niuniu');
  const game=games.list.find(g=>g.id==='niuniu'),f=await fixture(game,rows.find(r=>r.room_type===24&&r.play_mode===3));
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];niuniu.begin(f.io,f.table,clock);
  const h=f.table.hand,p=h.players.find(p=>p.uid===1);h.bankerUid=2;h.bankerMultiple=1;h.deadline=clock+1000;const multiple=niuniu.betOptions(f.table,p)[0];
  for(const stage of ['deal','grab','banker','show','settle','ended']){h.stage=stage;assert.equal(niuniu.bet(f.io,f.table,1,multiple),false);assert.equal(p.bet,null);}
  for(const stage of ['deal','banker','bet','show','settle']){h.stage=stage;assert.equal(niuniu.grab(f.io,f.table,1,0),false);assert.equal(p.grab,null);}
  for(const deadline of [clock-1,clock,NaN,Infinity]){h.deadline=deadline;h.stage='bet';assert.equal(niuniu.bet(f.io,f.table,1,multiple),false);h.stage='grab';assert.equal(niuniu.grab(f.io,f.table,1,0),false);}
  h.deadline=clock+1000;p.member.pendingDeparture=true;h.stage='bet';assert.equal(niuniu.bet(f.io,f.table,1,multiple),false);p.member.pendingDeparture=false;
  h.stage='grab';assert.equal(niuniu.grab(f.io,f.table,1,0),true);h.stage='bet';assert.equal(niuniu.bet(f.io,f.table,1,multiple),true);assert.equal(p.member.point,10000);
});

test('sgay client bets close exactly at the deadline while trusted defaults finish the round',async t=>{
  const clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add('sgay');
  const game=games.list.find(g=>g.id==='sgay'),f=await fixture(game,rows.find(r=>r.room_type===32));
  f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];sgay.begin(f.io,f.table,clock);const h=f.table.hand,p=h.players[0];h.deadline=clock+1000;
  for(const stage of ['deal','show','settle','ended']){h.stage=stage;assert.equal(sgay.bet(f.io,f.table,p.uid,1),false);assert.equal(p.bet,null);assert.equal(p.member.point,10000);}
  h.stage='bet';for(const deadline of [clock-1,clock,NaN,Infinity]){h.deadline=deadline;assert.equal(sgay.bet(f.io,f.table,p.uid,1),false);}
  h.deadline=clock+1000;p.member.pendingDeparture=true;assert.equal(sgay.bet(f.io,f.table,p.uid,1),false);p.member.pendingDeparture=false;
  assert.equal(sgay.bet(f.io,f.table,p.uid,1),true);sgay.tick(f.io,f.table,h.deadline);assert.ok(h.players.every(p=>p.bet!==null));assert.equal(h.stage,'show');
});

for(const mode of [0,1]){
  test('blackjack '+mode+' initial bet and insurance have separate timed windows',async t=>{
    const clock=1800000000000;t.mock.method(Date,'now',()=>clock);covered.add('blackjack');
    const game=games.list.find(g=>g.id==='blackjack'),f=await fixture(game,rows.find(r=>r.room_type===31&&Number(r.play_mode)===mode));
    f.table.members=[{uid:1,pos:0,point:10000}];blackjack.begin(f.io,f.table,clock);const h=f.table.hand,p=h.players[0],body={betAmount:100,targetPos:mode===1?1:undefined};h.deadline=clock+1000;
    for(const state of Object.values(STATE).filter(s=>s!==STATE.BET)){h.state=state;assert.equal(blackjack.act(f.io,f.table,1,4501,body),false);assert.equal(p.member.point,10000);assert.equal(p.mainBet,0);}
    h.state=STATE.BET;for(const deadline of [clock-1,clock,NaN,Infinity]){h.deadline=deadline;assert.equal(blackjack.act(f.io,f.table,1,4501,body),false);}
    h.deadline=clock+1000;assert.equal(blackjack.act(f.io,f.table,1,4501,body),true);const point=p.member.point;
    for(const state of Object.values(STATE).filter(s=>s!==STATE.INSURANCE)){h.state=state;assert.equal(blackjack.act(f.io,f.table,1,4506,{buyInsurance:true}),false);assert.equal(p.member.point,point);}
    h.state=STATE.INSURANCE;h.deadline=clock;assert.equal(blackjack.act(f.io,f.table,1,4506,{buyInsurance:true}),false);
    h.deadline=clock+1000;assert.equal(blackjack.act(f.io,f.table,1,4506,{buyInsurance:true}),true);assert.equal(p.member.point,point-50);
  });
  for(const id of [4507,4508])test('blackjack '+mode+' extra stake '+id+' requires the current player window',async t=>{
    const clock=1800000000000;t.mock.method(Date,'now',()=>clock);
    const game=games.list.find(g=>g.id==='blackjack'),f=await fixture(game,rows.find(r=>r.room_type===31&&Number(r.play_mode)===mode));
    f.table.members=[{uid:1,pos:0,point:10000},{uid:2,pos:1,point:10000}];blackjack.begin(f.io,f.table,clock);
    const h=f.table.hand,p=h.players[0];p.mainBet=100;p.hands=[{cards:[1,14],betAmount:100,stood:false,splitHand:false,handIndex:0}];p.member.totalBet=100;h.turn=0;h.deadline=clock+1000;
    for(const state of [STATE.BET,STATE.DEAL,STATE.INSURANCE,STATE.CHECK,STATE.DEALER,STATE.SETTLE,STATE.END]){h.state=state;assert.equal(blackjack.act(f.io,f.table,1,id,{}),false);assert.equal(p.member.point,10000);}
    h.state=STATE.PLAYER;h.turn=1;assert.equal(blackjack.act(f.io,f.table,1,id,{}),false);h.turn=0;
    h.deadline=clock;assert.equal(blackjack.act(f.io,f.table,1,id,{}),false);h.deadline=clock+1000;
    assert.equal(blackjack.act(f.io,f.table,1,id,{}),true);assert.equal(p.member.point,9900);
  });
}

for(const game of games.list.filter(g=>g.kind==='slots'))test('slots '+game.id+' purchases require ready room state; owned reveals stay separate',async()=>{
  covered.add(game.id);const f=await fixture(game,rows.find(r=>game.roomTypes.includes(Number(r.room_type))));let calls=0;
  f.runtime.scratchTickets={async reveal(){calls++;return {code:0};}};const body={revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100};
  for(const mutate of [()=>f.table.closing=true,()=>f.table.retired=true,()=>f.table.cfg={...f.table.cfg,state:0},()=>f.session.roomHydrating=true,()=>f.session.roomClosing=true,()=>f.session.inRoom=false]){
    f.table.closing=false;f.table.retired=false;f.table.cfg={...f.table.cfg,state:1};f.session.roomHydrating=false;f.session.roomClosing=false;f.session.inRoom=true;mutate();
    await game.onMessage(f,3701,body);assert.notEqual(f.messages.at(-1).data.code,0);assert.equal(calls,0);assert.equal(f.session.wallet,10000);
  }
  f.session.inRoom=true;await game.onMessage(f,3701,body);assert.equal(calls,1);
  f.table.closing=true;await game.onMessage(f,3701,{revealMode:'SPECIFIED',serialFull:'owned'});assert.equal(calls,2,'revealing an existing ticket is not a new wager');
});

for(const id of ['mahjong','sss'])test(id+' exposes no direct client money-bet request in any room stage',async()=>{
  covered.add(id);const game=games.list.find(g=>g.id===id),f=await fixture(game,rows.find(r=>game.roomTypes.includes(Number(r.room_type))));
  for(const phase of ['idle','starting','playing','settled','closed']){f.table.phase=phase;assert.equal(await game.onMessage(f,SEND.BET,{betAmount:100,params:[{areaId:1,total:100}]}),false);assert.equal(f.session.wallet,10000);}
});

test('all registered game implementations have a phase-window check',()=>{assert.deepEqual(games.list.map(g=>g.id).filter(id=>!covered.has(id)),[]);});
