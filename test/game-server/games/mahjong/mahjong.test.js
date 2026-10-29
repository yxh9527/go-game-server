import test from 'node:test';
import assert from 'node:assert/strict';
import { MahjongGame } from '../../../../game-server/src/games/mahjong/MahjongGame.js';
import { roomRules } from '../../../../game-server/src/games/mahjong/config.js';
import { deckFor, counts, suit } from '../../../../game-server/src/games/mahjong/tiles.js';
import { shapes, evaluate, smallHu } from '../../../../game-server/src/games/mahjong/hand.js';
import { transfer } from '../../../../game-server/src/games/mahjong/scoring.js';
import * as engine from '../../../../game-server/src/games/mahjong/engine.js';
import { OP, PROTOCOL } from '../../../../game-server/src/games/mahjong/messages.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createRoomLogic } from '../../../../hall/src/rooms.js';
import * as decode from '../../../../hall/src/decode.js';
import { ranking } from '../../../../game-server/src/core/room-features.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';
import { tickRoom } from '../../../../game-server/src/core/robot.js';
import { createRegistry } from '../../../../game-server/src/registry.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';

function fixture(id=2604, hands, tail=[], end=[]) {
  const game=new MahjongGame(),row=seedRooms().find(r=>r.game_room_config_id===id),table=game.createTable(id*10000,row.room_type,row);
  table.members=Array.from({length:table.roomRules.maxPeople},(_,i)=>({uid:i+1,pos:i,name:'p'+i,icon:'1',point:10000,state:2,bot:true}));
  table.observers=[{uid:99,name:'observer'}];
  const sessions=[...table.members,{uid:99}].map(m=>({userId:m.uid,ws:m.uid,wallet:50000})),messages=[];
  const emit=(uid,id,data)=>messages.push({uid,id,data:structuredClone(data)});
  const io={env:'dev',broadcast:(id,data)=>emit(0,id,data),send:emit,sendUser:emit,forEachPlayer:fn=>sessions.forEach(fn),sessionFor:uid=>sessions.find(s=>s.userId===uid)};
  let deck;
  if(hands){
    const remain=deckFor(table.roomRules),take=c=>{const i=remain.indexOf(c);assert.ok(i>=0,'fixture must use physical wall');remain.splice(i,1);return c;};
    const first=hands.flatMap((cards,i)=>i===0?cards.slice(0,-1):cards);
    first.push(hands[0].at(-1));const opening=first.map(take),following=tail.map(take),ending=end.map(take);
    deck=[...opening,...following,...remain,...ending.reverse()];
  }
  engine.begin(io,table,1000,deck);
  return {game,table,io,messages,sessions};
}
function advance(f) {const h=f.table.hand;engine.tick(f.io,f.table,h.deadline);}
function finish(f){let now=1000,n=0;while(f.table.hand&&n++<2500){now+=2500;engine.tick(f.io,f.table,now);}assert.equal(f.table.hand,null);return now;}
function forceTurn(f,uid=1,now=7000){const h=f.table.hand;h.stage='turn';h.actorUid=uid;h.time=now;h.deadline=now+10000;return h;}
test('18 captured Mahjong room identities, amounts, mode/capacity and strict tier lookup',()=>{
  const rows=seedRooms().filter(r=>[26,28,30].includes(r.room_type)),rooms=createRoomLogic(decode);
  assert.equal(rows.length,18);
  for(const row of rows){const r=roomRules(row),p=rooms.enterRoomPayload(row,{},{});
    assert.equal(p.key,[row.room_type,row.play_mode,row.ante,row.room_classification,row.carry_min].join('/'));
    assert.equal(r.maxPeople,row.room_type===28?row.play_mode:row.play_mode===1?2:4);
    assert.equal(r.diFen,row.ante);assert.equal(rooms.findRoom(rows,p),row);
    assert.equal(rooms.findRoom(rows,{...p,ante:9999}),null);
    const t=new MahjongGame().createTable(1,row.room_type,row);
    assert.equal(new MahjongGame().buildConf(t)[r.family+'Params'].gameStartNum,r.maxPeople);
  }
});
test('physical decks: 108 Changsha, 116 blood-flow, 124/52 speed; exact suit and flower IDs',()=>{
  for(const [id,size] of [[2801,108],[3001,116],[2601,124],[2604,52]]){
    const r=roomRules(seedRooms().find(r=>r.game_room_config_id===id)),deck=deckFor(r);assert.equal(deck.length,size);
    if(id===3001)assert.equal(counts(deck)[27],8);
    if(id===2604)assert.ok(deck.every(c=>c>=18&&c<=30));
  }
  assert.deepEqual([suit(18),suit(0),suit(9),suit(27)],[1,2,3,4]);
});
test('winning structures reject crossing suits, wrong length and fake extra jokers',()=>{
  assert.ok(shapes([0,1,2,3,4,5,9,10,11,18,19,20,22,22],0,'csmj').standard);
  assert.ok(!shapes([7,8,9,22,22],0,'jsmj').standard);
  assert.ok(shapes([18,19,20,28,28],0,'jsmj').standard);
  assert.ok(!shapes([18,19,20,28],0,'jsmj').standard);
  const r=roomRules(seedRooms().find(r=>r.game_room_config_id===3001));
  assert.ok(evaluate([0,1,2,3,4,5,9,10,11,12,13,27,27,27],[],r,{queType:1,selfDraw:true}));
  assert.equal(evaluate([18,19,20,3,4,5,9,10,11,12,13,27,27,27],[],r,{queType:1,selfDraw:true}),null);
  assert.equal(evaluate([1,1,4,4,7,7,10,10,13,13],[],{family:'csmj'}),null);
});
test('speed additive fan, Changsha 258 eyes, blood-flow seven pairs and 512 cap follow help',()=>{
  const js={family:'jsmj'},cs={family:'csmj'},hz={family:'hzxl'};
  const value=evaluate([18,19,20,28,28],[],js,{selfDraw:true,ting:true,addFanCard:18,flowers:2});
  assert.equal(value.fan,1+2+3+20+10+10+1);
  assert.equal(evaluate([0,1,2,3,4,5,9,10,11,18,19,20,21,21],[],cs),null);
  assert.equal(evaluate([0,1,2,3,4,5,9,10,11,18,19,20,22,22],[],cs).fan,1);
  const q=evaluate([0,0,1,1,2,2,3,3,4,4,5,5,6,6],[],hz,{queType:1,selfDraw:true});
  assert.equal(q.base.huType,8);assert.equal(q.base.fan,6);
  const high=evaluate([0,0,0,2,2,2,4,4,4,6,6,6,8,8],[],hz,{selfDraw:true,afterKong:true,roots:4,redKongs:4});
  assert.equal(high.fan,512);
  assert.ok(smallHu([0,0,0,0,3,3,3,9,9,9,18,20,22]).includes(1));
});
test('per-session deal/snapshot privacy, query invariance and hidden kong faces',()=>{
  for(const id of [2604,2801,3002]){
    const f=fixture(id),h=f.table.hand,proto=PROTOCOL[h.rules.family];
    const ob=f.messages.find(m=>m.uid===99&&m.id===proto.deal).data;
    assert.ok(ob.players.every(p=>!p.handCards));
    const mine=f.messages.find(m=>m.uid===1&&m.id===proto.deal).data;
    assert.ok(mine.players.find(p=>p.uid===1).handCards.length>0);
    assert.ok(mine.players.filter(p=>p.uid!==1).every(p=>!p.handCards));
    const before=engine.recorder(f.table,1),waits=engine.tingMap(f.table,h.players[0]);
    h.players[1].handCards=h.players[1].handCards.slice().reverse();h.deck=h.deck.slice(0,h.index).concat(h.deck.slice(h.index).reverse());
    assert.deepEqual(engine.recorder(f.table,1),before);assert.deepEqual(engine.tingMap(f.table,h.players[0]),waits);
    h.players[1].groupCards=[{card:2,type:4,cards:[2,2,2,2],indices:[]}];
    const group=engine.snapshot(f.table,{userId:99}).memberDeskInfos[1].groupCards[0];
    assert.equal(group.card,-1);assert.deepEqual(group.cards,[-1,-1,-1,-1]);
    assert.ok(fairCodeDetail(f.table,99,1).pokerList.every(c=>!c.secretKey));
  }
});
test('exchange validates same suit and ownership; que choices cannot repeat or escape their phase',()=>{
  const f=fixture(3002),h=f.table.hand;advance(f);assert.equal(h.stage,'exchange');
  assert.equal(engine.exchange(f.io,f.table,1,[0,9,18],h.time+1),false);
  for(const p of h.players){const candidates=[1,2,3].map(s=>p.handCards.filter(c=>suit(c)===s)).find(a=>a.length>=3);
    assert.ok(engine.exchange(f.io,f.table,p.uid,candidates.slice(0,3),h.time+1));}
  assert.equal(h.stage,'que');
  assert.equal(engine.chooseQue(f.io,f.table,99,1,h.time+1),false);
  assert.equal(engine.chooseQue(f.io,f.table,1,4,h.time+1),false);
  assert.ok(engine.chooseQue(f.io,f.table,1,1,h.time+1));
  assert.equal(engine.chooseQue(f.io,f.table,1,2,h.time+1),false);
  assert.ok(engine.chooseQue(f.io,f.table,2,2,h.time+1));assert.equal(h.stage,'turn');
  assert.ok(f.messages.filter(m=>m.id===3862&&m.uid===99).every(m=>!m.data.cards));
});
test('invalid/out-of-turn/replayed/deadline actions cannot mutate tiles or money',()=>{
  const f=fixture(2604),h=forceTurn(f);const before=structuredClone(h.players.map(p=>({cards:p.handCards,point:p.member.point})));
  for(const [uid,body,at] of [[99,{type:2,card:18},7001],[2,{type:2,card:h.players[1].handCards[0]},7001],
    [1,{type:2,card:NaN},7001],[1,{type:8},7001],[1,{type:2,card:99},7001],[1,{type:2,card:h.players[0].handCards[0]},17000],
    [1,{uid:2,type:2,card:h.players[0].handCards[0]},7001]]) assert.equal(engine.action(f.io,f.table,uid,body,at),false);
  assert.deepEqual(h.players.map(p=>({cards:p.handCards,point:p.member.point})),before);
});
test('blood-flow updates the concealed hand before enabling input for the first and following turns',()=>{
  for(const id of [3001,3002]){
    const f=fixture(id),h=f.table.hand;advance(f);
    for(const p of h.players){
      const cards=[1,2,3].map(s=>p.handCards.filter(c=>suit(c)===s)).find(a=>a.length>=3).slice(0,3);
      assert.ok(engine.exchange(f.io,f.table,p.uid,cards,h.time+1));
    }
    for(const p of h.players)assert.ok(engine.chooseQue(f.io,f.table,p.uid,1,h.time+1));
    const assertOrder=()=>{
      const turn=f.messages.findLastIndex(m=>m.id===3852&&m.data.cursorUid===h.actorUid);
      const draw=f.messages.findLastIndex(m=>m.id===3853&&m.uid===h.actorUid&&m.data.type===OP.DRAW);
      assert.ok(draw>=0&&turn>draw,'3853 draws before 3852 checks the rendered hand');
      assert.equal(f.messages[draw].data.cardLen%3,2);
      assert.ok(f.messages.filter(m=>m.id===3853&&m.data.type===OP.DRAW&&m.data.uid===h.actorUid&&m.uid!==h.actorUid).every(m=>m.data.card===-1));
    };
    assertOrder();
    const p=h.players.find(p=>p.uid===h.actorUid);
    const card=p.handCards.find(c=>suit(c)===p.queType)??p.handCards[0];
    assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.DISCARD,card},h.time+1));
    if(h.stage==='response')for(const uid of Object.keys(h.offers))
      assert.ok(engine.action(f.io,f.table,Number(uid),{type:OP.PASS},h.time+1));
    assert.equal(h.stage,'turn');assert.notEqual(h.actorUid,p.uid);
    assertOrder();
  }
});

function bloodFlowDrawFixture(id=3002, cards=[18,19,20,21,22,23,24,25,26,1,1,3,4], tail=[], draw=5, queType=3) {
  const hands=[[9,9,10,10,11,11,12,12,13,13,14,14,15,16],cards];
  const row=seedRooms().find(r=>r.game_room_config_id===id),remaining=deckFor(roomRules(row));
  for(const c of hands.flat().concat(draw,tail)){
    const index=remaining.indexOf(c);assert.ok(index>=0);remaining.splice(index,1);
  }
  while(hands.length<roomRules(row).maxPeople)hands.push(remaining.splice(0,13));
  const f=fixture(id,hands,[draw,...tail]),h=forceTurn(f),p=h.players[1];
  p.queType=queType;p.bot=false;p.member.bot=false;
  assert.ok(engine.action(f.io,f.table,1,{type:OP.DISCARD,card:9},h.time+1));
  assert.equal(h.actorUid,p.uid);assert.equal(h.stage,'turn');assert.equal(p.drawn,draw);
  return {...f,p};
}

test('blood-flow six-tong self-draw sends a private native hu button with a numeric multiplier',()=>{
  for(const id of [3001,3002]){
    const f=bloodFlowDrawFixture(id),h=f.table.hand,p=f.p;
    const hint=f.messages.findLast(m=>m.id===3868&&m.uid===p.uid);
    assert.ok(hint,'3868 is required to display the original client operation panel');
    const hu=hint.data.operatorList.find(o=>o.type===OP.HU);
    assert.ok(hu);assert.equal(hu.card,5);assert.equal(hu.num,64,'one straight x concealed hand x self-draw');
    assert.ok(hint.data.operatorList.some(o=>o.type===OP.PASS));
    assert.ok(f.messages.filter(m=>m.id===3868&&m.uid!==p.uid).every(m=>!m.data.operatorList.some(o=>o.type===OP.HU)));
    const snap=engine.snapshot(f.table,{userId:p.uid},h.time+1);
    assert.deepEqual(snap.memberDeskInfos.find(m=>m.uid===p.uid).operatorList,hint.data.operatorList);
    const before=p.handCards.slice();engine.tick(f.io,f.table,h.deadline-1);
    assert.deepEqual(p.handCards,before,'a human may choose hu throughout the operation clock');
    assert.equal(p.huRecord.length,0);
    assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:5},h.deadline-1));
    assert.equal(p.huRecord.length,1);assert.equal(p.huRecord[0].card,5);assert.equal(p.huRecord[0].ziMo,true);
    assert.equal(p.delta,(h.rules.maxPeople-1)*h.rules.diFen*64);assert.equal(p.discardCount,0);
    assert.deepEqual(f.messages.findLast(m=>m.id===3868&&m.uid===p.uid).data.operatorList,[]);
  }
});

test('blood-flow passing a self-draw hides its buttons without discarding or extending the clock',()=>{
  const f=bloodFlowDrawFixture(),h=f.table.hand,p=f.p,before=p.handCards.slice(),deadline=h.deadline;
  assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.PASS},h.time+1));
  assert.equal(h.deadline,deadline);assert.deepEqual(p.handCards,before);assert.equal(p.discardCount,0);
  assert.deepEqual(f.messages.findLast(m=>m.id===3868&&m.uid===p.uid).data.operatorList,[]);
  assert.ok(!engine.options(f.table,p).some(o=>o.type===OP.HU));
  assert.equal(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:5},h.time+2),false);
  assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.DISCARD,card:5},h.time+3));
  assert.equal(p.discardCount,1);
});

test('blood-flow ordinary draws cannot display or accept a false self-draw hu',()=>{
  const f=bloodFlowDrawFixture(3002,[0,0,0,2,2,2,4,4,4,6,6,6,8]),h=f.table.hand,p=f.p;
  const hint=f.messages.findLast(m=>m.id===3868&&m.uid===p.uid);
  assert.ok(hint);assert.ok(!hint.data.operatorList.some(o=>o.type===OP.HU));
  assert.equal(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:5},h.time+1),false);
  assert.equal(p.huRecord.length,0);assert.equal(p.delta,0);
});

test('blood-flow concealed-kong buttons use the same private operation hint as self-draw hu',()=>{
  const f=bloodFlowDrawFixture(3002,[5,5,5,0,1,2,18,19,20,23,24,25,26]);
  const hint=f.messages.findLast(m=>m.id===3868&&m.uid===f.p.uid);
  assert.ok(hint.data.operatorList.some(o=>o.type===OP.AN_GANG&&o.card===5));
  assert.ok(hint.data.operatorList.some(o=>o.type===OP.PASS));
});

function bloodFlowAfterHu(draw,cards) {
  const f=bloodFlowDrawFixture(3002,cards,[9,draw]),h=f.table.hand,p=f.p;
  for(const other of h.players){other.bot=false;other.member.bot=false;}
  assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:5},h.time+1));
  const other=h.players.find(other=>other.uid===h.actorUid);
  assert.equal(other.drawn,9);
  assert.ok(engine.action(f.io,f.table,other.uid,{type:OP.DISCARD,card:9},h.time+1));
  assert.equal(h.stage,'turn');assert.equal(h.actorUid,p.uid);assert.equal(p.drawn,draw);
  assert.equal(p.huRecord.length,1);assert.equal(p.bot,false);assert.ok(!p.member.tuoGuanState);
  return f;
}

test('blood-flow human automatically discards the drawn tile after hu without waiting for timeout',()=>{
  const f=bloodFlowAfterHu(6),h=f.table.hand,p=f.p,deadline=h.deadline;
  const waiting=p.handCards.slice();waiting.splice(waiting.indexOf(6),1);
  assert.deepEqual(engine.options(f.table,p),[]);
  const before=p.discardCount;
  engine.tick(f.io,f.table,p.actionAt-1);assert.equal(p.discardCount,before);
  const at=p.actionAt;assert.ok(at<deadline);
  engine.tick(f.io,f.table,at);
  assert.equal(p.discardCount,before+1);assert.equal(p.playCards.at(-1),6);
  assert.deepEqual(p.handCards,waiting,'concealed waiting tiles stay intact');
  const discard=f.messages.findLast(m=>m.id===3853&&m.uid===p.uid&&m.data.type===OP.DISCARD);
  assert.equal(discard.data.card,6);assert.equal(discard.data.cardLen,13);
  const snap=engine.snapshot(f.table,{userId:p.uid},at);
  assert.equal(snap.memberDeskInfos.find(m=>m.uid===p.uid).huRecord.length,1);
  assert.equal(p.member.tuoGuanState,undefined,'automatic draw-discard does not enable account trusteeship');
});

test('blood-flow repeated human hu stays selectable; passing resumes automatic draw-discard',()=>{
  for(const pass of [false,true]){
    const f=bloodFlowAfterHu(5),h=f.table.hand,p=f.p,deadline=h.deadline;
    assert.ok(engine.options(f.table,p).some(o=>o.type===OP.HU));
    engine.tick(f.io,f.table,p.actionAt);
    assert.equal(p.huRecord.length,1);assert.equal(p.discardCount,0);
    if(pass){
      assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.PASS},h.deadline-500));
      assert.equal(h.deadline,deadline);assert.deepEqual(engine.options(f.table,p),[]);
      engine.tick(f.io,f.table,deadline-400);
      assert.equal(p.discardCount,1);assert.equal(p.playCards.at(-1),5);
      assert.equal(p.huRecord.length,1);
    }else{
      engine.tick(f.io,f.table,deadline-1);assert.equal(p.huRecord.length,1);
      assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:5},deadline-1));
      assert.equal(p.huRecord.length,2);assert.equal(p.discardCount,0);
    }
  }
});

test('blood-flow passing kong clears that choice and an expired post-hu turn discards the draw',()=>{
  for(const pass of [false,true]){
    const f=bloodFlowAfterHu(1,[1,1,1,18,19,20,21,22,23,24,25,26,27]),h=f.table.hand,p=f.p;
    assert.ok(engine.options(f.table,p).some(o=>o.type===OP.AN_GANG&&o.card===1));
    engine.tick(f.io,f.table,p.actionAt);assert.equal(p.discardCount,0);
    const deadline=h.deadline;
    if(pass){assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.PASS},deadline-500));assert.deepEqual(engine.options(f.table,p),[]);}
    engine.tick(f.io,f.table,pass?deadline-400:deadline);
    assert.equal(p.discardCount,1);assert.equal(p.playCards.at(-1),1);assert.equal(p.groupCards.length,0);
  }
});

test('captured 09:29 red-joker hu is valid and later automatic discards preserve its waiting hand',()=>{
  // Original four-player log: que=tong, 7/9-tiao, 111/23/666/78-wan,
  // one red joker, then draw another red joker. Use the same physical hand
  // and following human draws in a two-player fixture for direct turn control.
  const waiting=[15,17,18,18,18,19,20,23,23,23,24,25,27];
  const f=bloodFlowDrawFixture(3002,waiting,[9,6,10,21],27,2),h=f.table.hand,p=f.p;
  for(const other of h.players){other.bot=false;other.member.bot=false;}
  const hu=engine.options(f.table,p).find(o=>o.type===OP.HU);
  assert.deepEqual(hu,{type:OP.HU,card:27,num:8,huType:10});
  assert.ok(engine.action(f.io,f.table,p.uid,{type:OP.HU,card:27},h.time+1));
  assert.deepEqual(p.handCards,waiting);
  const passOther=()=>{
    const other=h.players.find(other=>other.uid===h.actorUid);
    assert.notEqual(other.uid,p.uid);
    assert.ok(engine.action(f.io,f.table,other.uid,{type:OP.DISCARD,card:other.drawn},h.time+1));
    assert.equal(h.actorUid,p.uid);assert.equal(h.stage,'turn');
  };
  passOther();assert.equal(p.drawn,6);assert.deepEqual(engine.options(f.table,p),[]);
  const at=p.actionAt;assert.ok(at<h.deadline);
  engine.tick(f.io,f.table,at);
  assert.equal(p.playCards.at(-1),6);assert.deepEqual(p.handCards,waiting);
  passOther();assert.equal(p.drawn,21);
  assert.ok(engine.options(f.table,p).some(o=>o.type===OP.HU&&o.card===21));
  engine.tick(f.io,f.table,p.actionAt);
  assert.equal(p.discardCount,1,'later valid four-wan hu remains a human choice');
  engine.tick(f.io,f.table,h.deadline);
  assert.equal(p.playCards.at(-1),21,'timeout discards four-wan, not the original nine-tiao');
  assert.deepEqual(p.handCards,waiting);
  assert.equal(p.huRecord.length,1);
});

test('response windows wait for all players, prioritize hu and reject unrelated replies',()=>{
  const f=fixture(2804),h=forceTurn(f),[source,a,b]=h.players;
  h.stage='response';h.lastOut={uid:source.uid,card:1};source.playCards=[1];
  a.handCards=[0,0,0,2,2,2,3,3,3,4,4,4,1];
  h.offers={[a.uid]:[{type:8,card:1},{type:7}],[b.uid]:[{type:3,card:1},{type:7}]};h.responses={};
  const bCards=b.handCards.slice();
  assert.ok(engine.action(f.io,f.table,b.uid,{type:3,card:1},7001));assert.equal(h.stage,'response');
  assert.equal(engine.action(f.io,f.table,b.uid,{type:3,card:1},7002),false);
  assert.ok(engine.action(f.io,f.table,a.uid,{type:8,card:1},7003));assert.equal(f.table.hand,null);
  assert.deepEqual(b.handCards,bCards,'losing priority action must not consume tiles');
});
test('short balances and simultaneous winners conserve money without response-order bias',()=>{
  const make=(uid,pos,point)=>({uid,pos,openingPoint:point,member:{point,totalBet:0},delta:0,details:[]});
  for(const reverse of [false,true]){const from=make(1,0,5),a=make(2,1,100),b=make(3,2,100);
    const claims=[{from,to:a,amount:10},{from,to:b,amount:10}];transfer(reverse?claims.reverse():claims);
    assert.deepEqual([from.member.point,a.member.point,b.member.point],[0,103,102]);}
});
test('both modes of all families complete bot hands, conserve wall/chips and publish settlement before ranking',()=>{
  for(const id of [2601,2604,2801,2804,3001,3002])for(let n=0;n<3;n++){
    const f=fixture(id),hand=f.table.hand;const ended=finish(f),r=f.table.lastMahjongResult,capacity=f.table.roomRules.maxPeople;
    assert.equal(r.resultList.length,capacity);assert.equal(f.table.members.reduce((n,p)=>n+p.point,0)+f.table.taxCollected,capacity*10000);
    assert.ok(r.resultList.every(p=>Number.isSafeInteger(p.score)&&p.point>=0));
    assert.equal(f.table.startAt-ended,5000);
    const settle=f.messages.findIndex(m=>m.id===PROTOCOL[f.table.roomRules.family].settle),rank=f.messages.findIndex((m,i)=>i>settle&&m.id===1244);
    assert.ok(settle>=0&&rank>settle);assert.equal(ranking(f.table).totalHands,1);
    assert.equal(ranking(f.table).userList.some(p=>p.uid===99),false);
    const detail=fairCodeDetail(f.table,1,1);assert.ok(detail.pokerList.some(c=>c.secretKey));
    assert.ok(detail.pokerList.slice(hand.index,hand.tailIndex).every(c=>!c.secretKey),'undealt wall remains encrypted');
  }
});
test('carry-in during a hand remains independent of payouts and history authorization',()=>{
  const f=fixture(2604);f.table.members[0].point+=777;finish(f);
  assert.equal(f.table.members.reduce((n,p)=>n+p.point,0)+f.table.taxCollected,20777);
  const data=engine.historyPayload(f.table,{beginNum:-1,endNum:-1},1);assert.equal(data.diFen,10);assert.equal(data.playBackList[0].playerList.length,2);
  assert.ok(engine.historyDetail(f.table,1,1));assert.equal(engine.historyDetail(f.table,1,12345),null);
  assert.equal(engine.historyPayload(f.table,{},12345).playBackList.length,0);
  const detail=engine.historyDetail(f.table,1,99).exploitsInfoMsgs[0];assert.doesNotThrow(()=>JSON.parse(detail.inningResults));
  assert.doesNotThrow(()=>JSON.parse(detail.roundList));assert.doesNotThrow(()=>JSON.parse(detail.inningInfo));
});
test('no-fold mid-hand leave preserves responsibility and refunds only after settlement',async()=>{
  const f=fixture(2604),member=f.table.members[0],session=f.sessions[0];member.bot=false;let credited=0;
  const ctx={table:f.table,session,io:f.io,send(){},wallet:{async load(){},async credit(s,n){credited+=n;s.wallet+=n;return{ok:true};},async persist(){}},runtime:{log:{error(){}}}};
  assert.equal(f.game.onLeave(ctx),0);assert.equal(member.pendingDeparture,true);assert.ok(f.table.members.includes(member));
  assert.equal(credited,0);finish(f);assert.equal(ranking(f.table).totalHands,1);
  const amount=member.point;
  await f.game.afterRound(ctx);await f.game.afterRound(ctx);
  assert.equal(credited,amount);assert.ok(!f.table.members.includes(member));
});
test('physical speed flowers pay once during initial deal and replacement, separate from hu',()=>{
  const f=fixture(2604,[[30,18,19,20,21,22],[23,24,25,26]],[30,30,27]);
  const h=f.table.hand,[a,b]=h.players;
  assert.equal(a.flowers,1);assert.deepEqual([a.delta,b.delta],[10,-10]);
  forceTurn(f);a.ting=false;
  assert.ok(engine.action(f.io,f.table,1,{type:2,card:18},7001));
  assert.equal(b.flowers,2);assert.deepEqual([a.delta,b.delta],[-10,10]);
  assert.equal(b.details.filter(d=>d.category===1&&d.score>0).length,2);
  assert.equal(a.member.point+b.member.point,20000);
  engine.settle(f.io,f.table,8000);
  const history=engine.historyPayload(f.table,{},1).playBackList[0];
  assert.deepEqual(history.flowerFan,{1:-1,2:1});assert.deepEqual(history.gangFan,{1:0,2:0});
});
test('Changsha genuine kong requires a ready hand; supplement remains unlocked',()=>{
  const f=fixture(2801,[[0,0,0,0,3,4,5,9,10,11,18,19,20,22],[1,1,2,2,6,6,7,7,12,12,13,13,16]],[],[22,22,23,24]);
  const h=forceTurn(f),p=h.players[0],wall=h.deck.slice();
  h.birdCards=[0,1];
  assert.ok(engine.options(f.table,p).some(o=>o.type===4&&o.card===0));
  assert.ok(engine.action(f.io,f.table,1,{type:4,card:0},7001));
  assert.equal(p.ting,true);assert.equal(h.stage,'gang');assert.equal(h.gangTail.length,4);
  assert.deepEqual(h.deck,wall,'tail draws cannot mutate the committed wall');
  assert.ok(engine.action(f.io,f.table,1,{type:8,card:22},7002));
  assert.equal(p.huRecord.length,2,'each physical winning tail tile is scored');
  assert.equal(p.huRecord.reduce((n,r)=>n+r.score,0),p.delta);
  assert.deepEqual(f.table.lastMahjongResult.zhaNiaoCards,[0,1]);
  assert.equal(h.index,27,'birds come from the independent deck, not the main wall');
  const g=fixture(2801,[[0,0,0,0,3,4,6,9,10,13,18,19,24,22],[1,1,2,2,6,6,7,7,12,12,13,13,16]]);
  forceTurn(g);const q=g.table.hand.players[0];
  assert.equal(engine.options(g.table,q).some(o=>o.type===4),false);
  assert.ok(engine.options(g.table,q).some(o=>o.type===16&&o.card===0));
  assert.equal(engine.action(g.io,g.table,1,{type:4,card:0},7001),false);
  assert.ok(engine.action(g.io,g.table,1,{type:16,card:0},7002));assert.equal(q.ting,false);
});
test('Changsha sea tile can be declined by each player without revealing the wall',()=>{
  const f=fixture(2801),h=forceTurn(f);h.index=h.tailIndex-1;
  const card=h.players[0].handCards[0];
  assert.ok(engine.action(f.io,f.table,1,{type:2,card},7001));
  if(h.stage==='response')for(const p of h.players)if(engine.options(f.table,p).some(o=>o.type===7))engine.action(f.io,f.table,p.uid,{type:7},7002);
  assert.equal(h.stage,'sea');
  const first=h.actorUid;assert.ok(engine.action(f.io,f.table,first,{type:7},7003));
  assert.equal(engine.action(f.io,f.table,first,{type:1},7004),false);
  assert.ok(engine.action(f.io,f.table,h.actorUid,{type:7},7005));assert.equal(f.table.hand,null);
  assert.equal(f.table.lastMahjongResult.leftCardLen,1);
  assert.ok(!fairCodeDetail(f.table,1,1).pokerList.at(-1).secretKey);
});
test('shared robot traffic fills a full-table game only after a human takes the reserved seat',t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const game=new MahjongGame(),row=seedRooms().find(r=>r.game_room_config_id===2601),table=game.createTable(1,26,row);
  table.cfg.robot_behavior={checkMinMs:1000,checkMaxMs:1000,joinProbability:1,leaveProbability:0,carryMinMs:1000,carryMaxMs:1000};
  const session={userId:42,wallet:10000},ctx={table,session,io:{broadcast(){}},send(){}};
  game.watch(table,session);
  for(let i=0;i<7;i++){tickRoom(game,ctx,now,()=>0);now+=1000;}
  assert.equal(table.members.length,3);
  game.sit(table,session,ctx,{buyIn:2000,pos:3});
  assert.equal(table.members.length,4);
  // The inverse ordering is the real lobby flow: human sits before the third bot.
  table.members=table.members.filter(m=>m.uid===42);
  for(let i=0;i<7;i++){tickRoom(game,ctx,now,()=>0);now+=1000;}
  assert.equal(table.members.length,4);assert.equal(game.seated(table).length,4);
});
test('versioned handler adopts live Mahjong tables without resetting a hand, wallet or room clocks',async()=>{
  const f=fixture(3002),hand=f.table.hand,registry=createRegistry();
  registry.setTable(f.table.roomId,f.table,0,'mahjong');
  const before={createdAt:f.table.createdAt,expiresAt:f.table.expiresAt,deadline:hand.deadline,deck:hand.deck,
    members:f.table.members,stats:f.table.roomFeatures,balances:f.table.members.map(m=>m.point)};
  await createHandler({env:'prod',hotVersion:'mahjong-regression-v2',registry,config:{},log:{info(){},error(){}}});
  assert.equal(f.table.hand,hand);assert.equal(hand.deadline,before.deadline);assert.equal(hand.deck,before.deck);
  assert.equal(f.table.createdAt,before.createdAt);assert.equal(f.table.expiresAt,before.expiresAt);
  assert.equal(f.table.members,before.members);assert.equal(f.table.roomFeatures,before.stats);
  assert.deepEqual(f.table.members.map(m=>m.point),before.balances);
});
test('blood-flow special triplets consume jokers once and cannot mix a third suit into two-suit bases',()=>{
  const r={family:'hzxl'};
  const withJokers=evaluate([0,0,0,1,1,27,2,2,2,3,3,3,4,4],[],r,{selfDraw:true});
  assert.equal(withJokers.base.huType,3);assert.equal(withJokers.base.fan,32);
  const mixed=evaluate([0,0,0,10,10,10,20,20,20,6,6,6,4,4],[],r,{selfDraw:true});
  assert.equal(mixed.base.huType,9,'three suits are not a two-suit consecutive-triplet pattern');
  const nine=evaluate([0,0,0,1,2,3,4,5,6,7,8,8,27,4],[],r,{selfDraw:true});
  assert.equal(nine.base.huType,0);assert.equal(nine.base.fan,128);
});
test('Changsha declarations wait for all responses and expose the native dice/hit-player structure',()=>{
  const f=fixture(2801,[[0,0,0,0,3,4,5,9,10,11,18,19,20,22],[1,1,2,2,6,6,7,7,12,12,13,13,16]]);
  advance(f);const h=f.table.hand;assert.equal(h.stage,'first');
  assert.ok(engine.action(f.io,f.table,1,{type:10},h.time+1));
  assert.deepEqual(h.players.map(p=>p.delta),[0,0]);
  assert.ok(engine.action(f.io,f.table,2,{type:10},h.time+2));
  const shows=f.messages.filter(m=>m.id===4210).map(m=>m.data[0]);assert.equal(shows.length,2);
  for(const show of shows){assert.equal(show.anchorPos,h.bankerPos);assert.ok(show.dices.every(d=>d>=1&&d<=4));
    assert.equal(show.hitPlayers.reduce((n,p)=>n+p.hitCards.length,0),2);}
  assert.equal(h.players.reduce((n,p)=>n+p.delta,0),0);
  assert.equal(engine.options(f.table,h.players[0]).some(o=>o.type===11),false,'initial four-of-a-kind cannot be claimed again as mid-hand hu');
  engine.settle(f.io,f.table,8000);
  const history=engine.historyPayload(f.table,{},1).playBackList[0];
  for(const result of history.playerList){
    assert.equal(result.startHuScore,h.players.find(p=>p.uid===result.uid).delta);
    for(const key of ['startHuScore','midHuScore','finalHuScore','startHuFan','midHuFan','finalHuFan'])assert.ok(Number.isFinite(result[key]));
  }
});
test('short room operation clocks still allow robot decisions before timeout',t=>{
  t.mock.method(Math,'random',()=>0.999);
  const f=fixture(2604),h=forceTurn(f);h.rules.opTime=2;h.rules.responseTime=2;
  assert.ok(engine.action(f.io,f.table,1,{type:2,card:h.players[0].handCards[0]},7001));
  assert.ok(h.players.every(p=>p.actionAt<h.deadline));
});
