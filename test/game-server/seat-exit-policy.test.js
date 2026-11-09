import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {SEND,PUSH} from '../../game-server/src/messages.js';
import {HoldemGame} from '../../game-server/src/games/holdem/HoldemGame.js';
import {ZjhGame} from '../../game-server/src/games/zjh/ZjhGame.js';
import {loadGames,gameOf} from '../../game-server/src/games/catalog.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {ZJH_SEND,ZJH_OP} from '../../game-server/src/games/zjh/messages.js';
import {OP} from '../../game-server/src/games/holdem/op.js';
import * as niuniu from '../../game-server/src/games/niuniu/engine.js';
import * as sss from '../../game-server/src/games/sss/engine.js';
import * as blackjack from '../../game-server/src/games/blackjack/engine.js';
import * as sgay from '../../game-server/src/games/sgay/engine.js';
import * as mahjong from '../../game-server/src/games/mahjong/engine.js';

async function fixture(roomType=19){
  const game=roomType===25?new ZjhGame():new HoldemGame(),registry=createRegistry();
  const table=game.createTable(700089,roomType,{game_room_config_id:70,carry_min:100});table.botTarget=0;
  registry.setTable(table.roomId,table,7,game.id);
  const credits=[],runtime={env:'dev',hotVersion:'seat-exit-policy',registry,configs:[],findConfig:()=>null,
    wallet:{async load(s){s.wallet=10000;},async persist(){},credit(s,amount){credits.push([s.userId,amount]);s.wallet+=amount;return {ok:true};},
      debit(s,amount){if(s.wallet<amount)return {ok:false};s.wallet-=amount;return {ok:true};}},log:{info(){},error(){}}};
  let handler=await createHandler(runtime);
  function connect(uid,point=5000){
    const frames=[],ws={readyState:1,send:data=>frames.push(decodeFrame(data))};
    const session={userId:uid,name:String(uid),agentId:7,roomId:table.roomId,gameId:game.id,inRoom:true,authenticated:true,wallet:10000};
    const member={uid,name:String(uid),pos:table.members.length,point,state:1,totalBet:0};
    table.members.push(member);registry.bind(ws,session);return {ws,session,member,frames};
  }
  return {runtime,table,game,registry,credits,connect,get handler(){return handler;},
    request:(p,id,body)=>handler.onMessage(p.ws,encodeFrame(id,body)),async reload(){runtime.hotVersion+='-next';handler=await createHandler(runtime);}};
}

for(const type of [19,25])test(type+': active, folded and all-in players must stand after settlement before explicit exit',async()=>{
  const f=await fixture(type),players=[f.connect(1),f.connect(2),f.connect(3)];
  f.table.phase='starting';f.table.startAt=0;await f.handler.tick();assert.ok(f.table.hand);
  const p=players.find(p=>p.member.uid===f.table.hand.actorUid),hand=f.table.hand;
  const actions=type===25?ZJH_SEND.ACTION:SEND.DZPK_SEND_ACTION,fold=type===25?ZJH_OP.FOLD:OP.ABANDON;
  const before=JSON.stringify(hand),balance=p.session.wallet,point=p.member.point;
  await f.request(p,SEND.SEND_LEVEL_OUT);
  assert.equal(p.session.inRoom,true);assert.equal(JSON.stringify(hand),before);assert.equal(p.member.point,point);assert.equal(p.session.wallet,balance);
  assert.equal(p.frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM),false);assert.ok(p.frames.some(r=>r.msgid===9999));assert.equal(f.credits.length,0);
  await f.request(p,actions,{operation:fold});assert.ok(p.member.folded);assert.ok(f.table.hand,'other two participants are still playing');
  const folded=JSON.stringify(f.table.hand);
  await f.request(p,SEND.SEND_LEVEL_OUT);assert.equal(JSON.stringify(f.table.hand),folded);assert.equal(p.session.inRoom,true);
  p.member.allIn=true;await f.request(p,SEND.SEND_LEVEL_OUT);assert.equal(p.session.inRoom,true);delete p.member.allIn;
  await f.request(p,SEND.SEND_NEXT_ROUND_STANDUP);assert.equal(p.member.standAfterRound,true);
  assert.ok(f.table.members.includes(p.member));assert.equal(f.table.hand,hand);assert.equal(f.credits.length,0);
  await f.request(p,SEND.SEND_STANDUP);assert.ok(f.table.members.includes(p.member),'direct stand cannot fold/remove this hand participant');
  assert.equal(f.credits.length,0);assert.equal(p.member.pendingDeparture,undefined);
  await f.reload();assert.equal(f.table.hand,hand);assert.equal(p.member.standAfterRound,true);
  const all=new Map(players.map(p=>[p.member.uid,p]));
  for(let n=0;n<4&&f.table.hand;n++)await f.request(all.get(f.table.hand.actorUid),actions,{operation:fold});
  assert.equal(f.table.hand,null);assert.equal(f.table.members.includes(p.member),false);assert.ok(f.table.observers.some(o=>o.uid===p.member.uid));
  assert.equal(p.session.inRoom,true,'automatic standing leaves the player observing the same room');
  const paid=f.credits.filter(([uid])=>uid===p.member.uid);assert.equal(paid.length,1);assert.ok(paid[0][1]>0);
  assert.equal(p.session.wallet,balance+paid[0][1]);
  p.frames.length=0;await f.request(p,SEND.SEND_LEVEL_OUT);assert.equal(p.session.inRoom,false);
  assert.ok(p.frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM&&r.payload.uid===p.member.uid));
  await f.request(p,SEND.SEND_LEVEL_OUT);assert.equal(f.credits.filter(([uid])=>uid===p.member.uid).length,1);
});

test('seated players cannot bypass exit policy by requesting another game room',async()=>{
  const f=await fixture(),p=f.connect(1),source=f.table;
  await f.request(p,SEND.SEND_JOIN_ROOM,{roomId:990000,roomType:25,changeRoom:true});
  assert.equal(p.session.roomId,source.roomId);assert.equal(p.session.inRoom,true);assert.ok(source.members.includes(p.member));
  assert.equal(f.registry.tables.size,1,'denied switches do not create a destination room');assert.equal(f.credits.length,0);
  assert.ok(p.frames.some(r=>r.msgid===9999));
});

test('all normal seat games enforce leave-after-standing, while hundred rooms exit directly',async()=>{
  const games=await loadGames('seat-exit-all-types');
  for(const type of [19,24,25,26,27,28,30,31,32,50]){
    const registry=createRegistry(),game=gameOf(games,type),cfg=seedRooms().find(r=>Number(r.room_type)===type);
    const table=game.createTable(800000+type,type,cfg);table.botTarget=0;
    const frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
    const session={userId:42,agentId:7,roomId:table.roomId,gameId:game.id,inRoom:true,authenticated:true,wallet:10000};
    const member={uid:42,name:'Player',point:5000,pos:0,state:1,hole:[1,2,3],totalBet:0};
    table.members ||= [];table.members.push(member);table.phase='playing';
    table.hand={statsPlayers:[member],players:[member],actorUid:42,deadline:Date.now()+100000};
    registry.setTable(table.roomId,table,7,game.id);registry.bind(ws,session);
    const handler=await createHandler({env:'dev',hotVersion:'exit-types-'+type,registry,configs:[],findConfig:()=>null,
      wallet:{async persist(){},credit(){assert.fail('exit rejection cannot release chips');}},log:{info(){},error(){}}});
    await handler.onMessage(ws,encodeFrame(SEND.SEND_LEVEL_OUT));
    if(type===50){assert.equal(session.inRoom,false);assert.ok(frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM));}
    else{assert.equal(session.inRoom,true,'seat game '+type);assert.ok(table.members.includes(member));assert.ok(frames.some(r=>r.msgid===9999));
      assert.equal(frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM),false);}
  }
});

for(const [type,name,engine]of [[24,'牛牛',niuniu],[31,'二十一点',blackjack],[27,'十三水',sss],[32,'三公',sgay],
  [26,'极速麻将',mahjong],[28,'长沙麻将',mahjong],[30,'红中血流',mahjong]]){
  test(name+': actual dealing, deferred standing, settlement and explicit exit preserve the room and balance',async()=>{
    const games=await loadGames('seat-exit-full-'+type),game=gameOf(games,type),registry=createRegistry();
    const cfg=seedRooms().find(r=>Number(r.room_type)===type&&(type!==31||Number(r.play_mode)===0));
    const table=game.createTable(820000+type,type,cfg);table.botTarget=0;
    const players=new Map(),messages=[],credits=[];
    const emit=(uid,id,data)=>{messages.push({uid,id,data:structuredClone(data)});players.get(uid)?.frames.push({msgid:id,payload:structuredClone(data)});};
    const io={env:'dev',broadcast:(id,data)=>{for(const uid of players.keys())emit(uid,id,data);},send:emit,sendUser:emit,
      forEachPlayer:callback=>{for(const p of players.values())callback(p.session);},sessionFor:uid=>players.get(uid)?.session};
    const runtime={env:'dev',hotVersion:'full-seat-policy-'+type,registry,configs:[],findConfig:()=>null,
      wallet:{async load(s){s.wallet=1000000000;},async persist(){},credit(s,amount){credits.push([s.userId,amount]);s.wallet+=amount;return {ok:true};}},
      log:{info(){},error(...args){assert.fail(args.join(' '));}}};
    registry.setTable(table.roomId,table,7,game.id);
    let handler=await createHandler(runtime);
    const count=[26,28,30].includes(type)?table.roomRules.maxPeople:2;
    for(let pos=0;pos<count;pos++){
      const uid=pos+1,frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
      const session={userId:uid,name:'P'+uid,agentId:7,gameId:game.id,roomId:table.roomId,inRoom:true,authenticated:true,wallet:1000000000};
      const member={uid,pos,name:session.name,point:Math.max(table.carryMin,1000)*1000,state:2,bot:false,totalBet:0};
      table.members.push(member);registry.bind(ws,session);players.set(uid,{member,session,frames,ws});
    }
    const own=players.get(1),ctx={runtime,table,session:own.session,io,send:(id,data)=>emit(1,id,data)};
    const request=(id,body)=>handler.onMessage(own.ws,encodeFrame(id,body));
    engine.begin(io,table,1000);assert.ok(table.hand,name+' really deals a hand');
    const hand=table.hand,balance=own.session.wallet,point=own.member.point;
    await request(SEND.SEND_LEVEL_OUT);assert.equal(own.session.inRoom,true);assert.equal(table.hand,hand);
    assert.equal(own.member.point,point);assert.equal(own.session.wallet,balance);assert.equal(credits.length,0);
    assert.ok(own.frames.some(r=>r.msgid===9999));assert.equal(own.frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM),false);
    await request(SEND.SEND_NEXT_ROUND_STANDUP);assert.equal(own.member.standAfterRound,true);
    await request(SEND.SEND_STANDUP);assert.ok(table.members.includes(own.member));assert.equal(credits.length,0);
    runtime.hotVersion+='-reload';handler=await createHandler(runtime);assert.equal(table.hand,hand);assert.equal(own.member.standAfterRound,true);
    let now=1000;
    for(let i=0;i<2500&&table.hand;i++){now+=30000;engine.tick(io,table,now);}
    assert.equal(table.hand,null,name+' completes its actual engine settlement');
    const settled=own.member.point;await game.afterRound(ctx);
    assert.equal(table.members.includes(own.member),false);assert.ok(table.observers.some(p=>p.uid===1));
    assert.equal(own.session.inRoom,true);assert.equal(own.session.wallet,balance+settled);
    assert.equal(credits.filter(([uid])=>uid===1).length,1);
    assert.equal(own.frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM),false,'standing is not room exit');
    await request(SEND.SEND_LEVEL_OUT);assert.equal(own.session.inRoom,false);
    assert.ok(own.frames.some(r=>r.msgid===PUSH.USER_LEVEL_ROOM&&r.payload.uid===1));
    await request(SEND.SEND_LEVEL_OUT);assert.equal(credits.filter(([uid])=>uid===1).length,1);
  });
}
