import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { NiuniuGame } from '../../../../game-server/src/games/niuniu/NiuniuGame.js';
import * as engine from '../../../../game-server/src/games/niuniu/engine.js';
import { PUSH, SEND } from '../../../../game-server/src/games/niuniu/messages.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';

function fixture(mode=3,see=4) {
  const game = new NiuniuGame();
  const table = game.createTable(190000,24,{ game_room_config_id:19,play_mode:mode,see_card_no:see,ante:10,carry_min:1000 });
  table.members = [1,2,3].map((uid,pos)=>({uid,pos,point:10000,name:'p'+uid,state:2}));
  table.observers=[{uid:99,name:'observer'}];
  const messages=[];
  const emit=(uid,id,data)=>messages.push({uid,id,data:structuredClone(data)});
  const sessions=[1,2,3,99].map(userId=>({userId,ws:userId,wallet:10000}));
  const io={env:'dev',broadcast:(id,data)=>emit(0,id,data),sendUser:emit,send:emit,
    forEachPlayer:fn=>sessions.forEach(fn),sessionFor:uid=>sessions.find(s=>s.userId===uid)};
  engine.begin(io,table,1000);
  return {game,table,messages,io,sessions};
}
function finish(f) {
  for(const p of f.table.hand.players) engine.grab(f.io,f.table,p.uid,p.uid===1?2:0);
  engine.tick(f.io,f.table,2200);
  engine.tick(f.io,f.table,6000);
  for(const p of f.table.hand.players) if(p.uid!==1) engine.bet(f.io,f.table,p.uid,engine.betOptions(f.table,p)[0]);
  engine.tick(f.io,f.table,6800);
  for(const p of f.table.hand.players) engine.show(f.io,f.table,p.uid);
  engine.tick(f.io,f.table,9000);
}

for(const [mode,see] of [[3,3],[3,4],[0,0],[7,4]]) test(`mode ${mode}, see ${see}: private deals, complete hand, reconnect and history`,()=>{
  const f=fixture(mode,see);
  const conf=f.game.buildConf(f.table);
  assert.equal(conf.qznnParams.seeCardNo,see);
  assert.equal(conf.qznnParams.gameTime,28800);
  for(const msg of f.messages.filter(m=>m.id===PUSH.DEAL)) {
    for(const p of msg.data) assert.equal(p.cardList.length,p.uid===msg.uid?see:0);
  }
  for(const session of f.sessions) {
    const snap=engine.snapshot(f.table,session);
    for(const p of snap.memberDeskInfos) {
      assert.equal(p.niuInfo.cardList.length,p.uid===session.userId?see:0);
      assert.equal(p.remarkName,'','client must not choose undefined as a nickname');
    }
  }
  assert.equal(engine.grab(f.io,f.table,99,4),false);
  assert.equal(engine.grab(f.io,f.table,1,NaN),false);
  assert.equal(engine.bet(f.io,f.table,1,5),false);
  finish(f);
  const results=f.messages.find(m=>m.id===PUSH.SETTLE).data;
  assert.equal(results.reduce((s,p)=>s+p.score,0),0);
  assert.equal(f.table.members.reduce((s,p)=>s+p.point,0),30000);
  assert.ok(results.every(p=>p.handPais.length===5&&Number.isFinite(p.point)));
  assert.equal(f.table.roomFeatures.totalHands,1);
  assert.equal(engine.historyPayload(f.table,{inningNum:1},99).dataInfo.firstGameList.length,3);
  assert.equal(engine.historyPayload(f.table,{inningNum:1},77).dataInfo.firstGameList.length,0);
  const modern=engine.historyPayload(f.table,{beginNum:0,endNum:0,roomId:f.table.roomId},99);
  assert.equal(modern.dataInfo.currentInningNum,1);
  assert.equal(modern.seeCardNo,see);
  assert.equal(modern.dataInfo.firstGameList[0].handCardListWithLaiZi.length,mode===7?5:0);
  assert.ok(fairCodeDetail(f.table,99,1).pokerList.some(c=>c.secretKey));
});

test('banker shortage pays stronger winners first, score is conserved',()=>{
  const f=fixture(); const [a,b,c]=f.table.hand.players;
  f.table.hand.bankerUid=1; f.table.hand.bankerMultiple=1;
  a.openingPoint=100; b.openingPoint=c.openingPoint=1000; b.bet=c.bet=25;
  a.result={strength:0,tie:[0],belv:1};b.result={strength:8,tie:[10],belv:2};c.result={strength:10,tie:[20],belv:4};
  const scores=engine.payouts(f.table);
  assert.equal(scores.get(3),100);assert.equal(scores.get(2),0);assert.equal(scores.get(1),-100);
  assert.equal([...scores.values()].reduce((s,p)=>s+p,0),0);
});

test('banker net winnings cannot exceed opening stake',()=>{
  const f=fixture();const [a,b,c]=f.table.hand.players;
  f.table.hand.bankerUid=1;f.table.hand.bankerMultiple=4;
  a.openingPoint=111;b.openingPoint=c.openingPoint=10000;b.bet=c.bet=25;
  a.result={strength:10,tie:[30],belv:4};b.result=c.result={strength:0,tie:[1],belv:1};
  const scores=engine.payouts(f.table);
  assert.equal(scores.get(1),111);
  assert.equal([...scores.values()].reduce((s,n)=>s+n,0),0);
});

test('live hand keeps its initial rules across hot-updated room policy',()=>{
  const f=fixture(3,3);
  const original=engine.betOptions(f.table,f.table.hand.players[1]);
  f.table.roomRules={...f.table.roomRules,seeCardNo:4,bettingMultiples:[99]};
  assert.equal(engine.snapshot(f.table,f.sessions[0]).memberDeskInfos[0].niuInfo.cardList.length,3);
  assert.deepEqual(engine.betOptions(f.table,f.table.hand.players[1]),original);
  finish(f);
  const row=engine.historyPayload(f.table,{beginNum:0,endNum:0},1);
  assert.equal(row.seeCardNo,3);
  assert.ok(row.dataInfo.firstGameList.every(p=>p.seeCardNo===3));
});

test('partial carry-out preserves admission and retries persistence without duplicate credit',async()=>{
  const f=fixture();finish(f);
  const m=f.table.members[0],s=f.sessions[0],before=m.point;
  let credits=0,writes=0;
  const ctx={table:f.table,session:s,io:f.io,send(){},body:{carryOutAmount:100},runtime:{wallet:{
    credit(session,amount){credits++;session.wallet+=amount;return {ok:true};},
    async persist(){if(++writes===1)throw Error('temporary unavailable');}
  }}};
  await assert.rejects(f.game.onCarryOut(ctx),/temporary/);
  await new Promise(resolve=>setImmediate(resolve));
  await f.game.afterRound(ctx);
  assert.equal(credits,1);assert.equal(writes,2);assert.equal(m.point,before-100);
  ctx.body.carryOutAmount=m.point;
  f.game.onCarryOut(ctx);assert.equal(m.point,before-100);
});

test('login hydration receives a private state instead of premature start animation',()=>{
  const f=fixture();
  f.sessions[0].niuniuHydrateUntil=999999;
  finish(f);f.messages.length=0;engine.begin(f.io,f.table,10000);
  assert.ok(f.messages.some(m=>m.uid===1&&m.id===3260));
  assert.ok(!f.messages.some(m=>m.uid===1&&m.id===3261));
  assert.ok(f.messages.some(m=>m.uid===2&&m.id===3261));
});

test('departed player keeps settlement liabilities; shared cash-out credits once after the hand',async()=>{
  const f=fixture(); const s=f.sessions[0];const ctx={table:f.table,session:s,io:f.io,send(){},runtime:{wallet:{
    persist:async()=>{},credit:(session,amount)=>{session.wallet+=amount;return {ok:true};}
  }}};
  assert.equal(f.game.onLeave(ctx),0);
  assert.equal(f.table.members.length,3);
  assert.equal(f.table.members[0].pendingDeparture,true);
  finish(f);
  const expected=f.table.members[0].point;
  await f.game.afterRound(ctx);
  assert.equal(s.wallet,10000+expected);
  assert.equal(f.table.members.length,2);
  assert.equal(f.table.observers.some(p=>p.uid===1),false);
  await f.game.afterRound(ctx);
  assert.equal(s.wallet,10000+expected);
});

test('original client consumes deal and settlement arrays without undefined fields',()=>{
  const f=fixture();
  const source=fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/Qznn/index.134d5.js',import.meta.url),'utf8');
  const a=source.indexOf("'Qznn_DataNotify':[function(");const section=source.slice(a,source.indexOf("':[function(",a+40));
  const method=name=>{const anchor="['prototype']['"+name+"']=";const i=section.indexOf(anchor)+anchor.length;
    const end=section.indexOf("['prototype']",i);return vm.runInNewContext('('+section.slice(i,section.lastIndexOf(',',end))+')',{console,F:{Qznn_Phase:{DEAL_PERFLOP:'DEAL_PERFLOP',SETTLE:'SETTLE'}}});};
  const model={GetSitDownPlayerByUid:uid=>model.seats.find(p=>p.uid===uid),PlayerPlaying:()=>true,
    seats:f.table.members.map(p=>({uid:p.uid,niuInfo:{}})),Data_Qznn_DealCard:{},Data_Qznn_Phase:{},
    Data_Qznn_Settlement:{},CreateFastModeNeedShowCardPlayerList(){}};
  method('SetDealCard').call(model,f.messages.find(m=>m.id===PUSH.DEAL&&m.uid===1).data);
  assert.equal(model.seats[0].niuInfo.cardList.length,4);
  finish(f);
  method('SetSettlement').call(model,f.messages.find(m=>m.id===PUSH.SETTLE).data);
  assert.equal(model.seats[0].niuInfo.cardList.length,5);
});
