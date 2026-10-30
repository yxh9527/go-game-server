import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry,findConfig } from '../../game-server/src/registry.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { encodeFrame,decodeFrame } from '../../game-server/src/codec.js';
import { SEND,PUSH } from '../../game-server/src/messages.js';
import { signControl,verifyControl } from '../../shared/tournament-control.js';
import { devControlSecret } from '../../cache/match/control.js';
import { blindAt } from '../../game-server/src/core/tournament-blinds.js';
import { OP } from '../../game-server/src/games/holdem/op.js';

async function fixture(){
  let moneyCalls=0;
  const runtime={env:'dev',hotVersion:'mtt-test',registry:createRegistry(),configs:seedRooms(),findConfig,
    gateway:{validateToken:async()=>true,getLoginData:async id=>({agentId:1,userName:'user'+id})},
    wallet:{load:async s=>{s.wallet=1000;},persist:async()=>{},debit:()=>{moneyCalls++;throw new Error('cash debit');},credit:(_s,n)=>{if(n)moneyCalls++;return {ok:true};}},
    log:{info(){},error(...e){assert.fail(e.join(' '));}}};
  let handler=await createHandler(runtime);
  const peers=new Map();
  async function control(action,more={},signature){
    const responses=[],ws={readyState:1,send:r=>responses.push(JSON.parse(String(r)))};
    const body=signControl(devControlSecret,{action,matchId:99,agentId:1,...more});if(signature)body.signature=signature;
    await handler.onMessage(ws,Buffer.from(JSON.stringify(body)));return responses[0];
  }
  async function join(uid,roomId){
    const messages=[],ws={readyState:1,send:r=>messages.push(decodeFrame(r))},peer={uid,ws,messages};peers.set(uid,peer);
    await handler.onMessage(ws,encodeFrame(SEND.ROOM_LOGIN,{userId:uid,userToken:'dev-'+uid,roomId}));
    await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId,roomType:101,isOb:true}));return peer;
  }
  const request=(p,id,data)=>handler.onMessage(p.ws,encodeFrame(id,data));
  const start=n=>control('start',{config:{initPoint:100,forceShowCard:true,startedAt:Date.now(),levels:[{min:5,max:10,bet:0,interval:60}]},
    players:Array.from({length:n},(_,i)=>({uid:10001+i,name:'user'+i,point:100}))});
  return {runtime,control,start,join,request,peers,moneyCalls:()=>moneyCalls,
    reload:async()=>{runtime.hotVersion='mtt-reloaded';handler=await createHandler(runtime);},tick:()=>handler.tick()};
}
test('tournament service commands require unmodified fresh signatures',()=>{
  const body=signControl('private-secret',{action:'start'},100000);
  assert.equal(verifyControl('private-secret',body,100001).action,'start');
  assert.throws(()=>verifyControl('wrong-secret',body,100001),/签名/);
  assert.throws(()=>verifyControl('private-secret',body,131000),/过期/);
  assert.throws(()=>verifyControl('',body,100001),/签名/);
});
test('tournament blinds advance in seconds and stop at the last configured level',()=>{
  const config={startedAt:100000,levels:[{min:5,max:10,bet:0,interval:60},{min:10,max:20,bet:2,interval:90},{min:20,max:40,bet:4,interval:0}]};
  assert.equal(blindAt(config,159000).nextUpBlindTime,1);
  assert.equal(blindAt(config,160000).bigBlind,20);
  assert.equal(blindAt(config,160000).nextUpBlindTime,90);
  assert.equal(blindAt(config,250000).currentBlindLv,3);
  assert.equal(blindAt(config,250000).isStopIncrBlind,true);
});
test('native MTT joins use preassigned chips; carry/stand/exit never cash them out; reload retains hand',async()=>{
  const f=await fixture();
  const denied=await f.control('start',{},'0'.repeat(64));assert.equal(denied.code,403);
  assert.equal(f.runtime.registry.tables.size,0);
  const result=await f.start(2);assert.equal(result.code,200);const roomId=result.data.tables[0].room_id;
  assert.equal((await f.start(2)).data.tables[0].room_id,roomId);
  const players=await Promise.all([f.join(10001,roomId),f.join(10002,roomId)]),table=f.runtime.registry.getTable(roomId,1,'holdem');
  const conf=players[0].messages.find(m=>m.msgid===PUSH.ROOM_TYPE_RESULT).payload;
  assert.equal(conf.roomType,101);assert.equal(conf.conf.roomType,19);assert.equal(conf.conf.isMtt,true);assert.equal(conf.conf.mttId,99);
  await f.request(players[0],SEND.LOGIN_ROOM);
  assert.ok(players[0].messages.some(m=>m.msgid===20009));
  for(const id of [SEND.SEND_CARRY_SCORE,SEND.SEND_STANDUP,SEND.CARRY_OUT_REQ,SEND.SEND_SITDOWN])await f.request(players[0],id,{carryIn:999,carryOutAmount:100});
  assert.equal(table.members[0].point,100);assert.equal(f.moneyCalls(),0);
  table.createdAt-=9*3600000;table.startAt=0;await f.tick();assert.ok(table.hand);
  const hand=table.hand;await f.reload();assert.equal(table.hand,hand);
  await f.request(players[0],SEND.SEND_LEVEL_OUT);assert.equal(table.members.length,2);assert.equal(f.moneyCalls(),0);
  await f.join(10001,roomId);assert.equal(table.members.length,2);
  const actor=f.peers.get(table.hand.actorUid);
  await f.request(actor,SEND.DZPK_SEND_ACTION,{operation:OP.ABANDON});
  assert.equal(table.hand,null);assert.equal(table.mtt.paused,true);
  assert.equal((await f.control('status')).data.ready,false,'settlement animations finish before moving seats');
  table.startAt=0;
  assert.equal(table.members.reduce((n,p)=>n+p.point,0),200);
  const snapshot=(await f.control('status')).data;assert.equal(snapshot.ready,true);
  await f.control('advance',{revision:snapshot.revision,ranks:{}});
  assert.equal(table.mtt.paused,false);assert.equal((await f.control('advance',{revision:0})).data.revision,1);
});
test('ten registered players split across two real tables and merge only at a completed-hand boundary',async()=>{
  const f=await fixture(),s=await f.start(10);assert.equal(s.data.tables.length,2);
  assert.deepEqual(s.data.tables.map(t=>t.player_nums),[5,5]);
  assert.equal((await f.control('advance',{revision:0})).code,409);
  const tables=[...f.runtime.registry.tables.values()];
  // A checkpoint fixture represents settled, chip-conserving elimination results.
  for(const table of tables){table.mtt.paused=true;table.phase='idle';table.startAt=0;for(const p of table.members){p.openingPoint=100;p.point=0;}}
  tables[0].members[0].point=400;tables[1].members[0].point=600;
  const response=await f.control('advance',{revision:0,ranks:{}});assert.equal(response.code,200);
  assert.equal(response.data.tables.length,1);assert.equal(response.data.tables[0].player_nums,2);
  assert.equal(response.data.players.reduce((n,p)=>n+p.point,0),1000);
  assert.equal(new Set(response.data.players.map(p=>p.uid)).size,2);
  const table=tables[0];table.mtt.paused=true;table.phase='idle';table.startAt=0;table.members[0].point=1000;table.members[1].point=0;
  assert.equal((await f.control('advance',{revision:1,ranks:{}})).data.finished,true);
  await f.tick();assert.equal(table.hand,null);assert.equal(f.moneyCalls(),0);
});
