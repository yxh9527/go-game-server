import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry,findConfig } from '../../game-server/src/registry.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { encodeFrame,decodeFrame } from '../../game-server/src/codec.js';
import { SEND,PUSH } from '../../game-server/src/messages.js';
const { signControl,verifyControl }=await importHotModule(new URL('../../shared/tournament-control.js',import.meta.url).href,'tournament-regression');
import { devControlSecret } from '../../cache/match/control.js';
const { blindAt }=await importHotModule(new URL('../../game-server/src/core/tournament-blinds.js',import.meta.url).href,'tournament-regression');
import { OP } from '../../game-server/src/games/holdem/op.js';
const {createTournamentControl}=await importHotModule(new URL('../../game-server/src/core/tournament.js',import.meta.url).href,'tournament-regression');

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
  const start=(n,patch={})=>control('start',{config:{initPoint:100,forceShowCard:true,startedAt:Date.now(),levels:[{min:5,max:10,bet:0,interval:60}],...patch},
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

test('manual pause waits for hand and animation, freezes clocks, and survives reload without replaying resume',async()=>{
  const f=await fixture(),started=Date.now();let at=started;f.runtime.clock=()=>at;
  const result=await f.start(2,{startedAt:started,lateSeconds:120,levels:[{min:5,max:10,bet:0,interval:60},{min:10,max:20,bet:0,interval:0}]});
  const table=f.runtime.registry.getTable(result.data.tables[0].room_id,1,'holdem');
  table.hand={sentinel:true};table.phase='playing';
  at+=10000;let response=await f.control('pause',{paused:true,pauseVersion:1});
  assert.equal(response.code,200);assert.equal(response.data.clock.pauseRequested,true);assert.equal(response.data.clock.pauseAt,null);assert.ok(table.hand);
  table.hand=null;table.phase='idle';table.mtt.paused=true;table.startAt=at+3000;
  at+=2999;assert.equal((await f.control('status')).data.clock.pauseAt,null);
  at++;response=await f.control('status');assert.equal(response.data.clock.pauseAt,at);assert.equal(response.data.ready,false);
  const remaining=response.data.clock.nextBlindAt-at,pauseAt=at;at+=180000;
  assert.equal((await f.control('status')).data.clock.nextBlindAt-pauseAt,remaining);
  assert.equal((await f.control('advance',{revision:0})).code,409);
  await f.reload();assert.equal((await f.control('status')).data.clock.pauseAt,pauseAt);
  response=await f.control('pause',{paused:false,pauseVersion:2});assert.equal(response.code,200);assert.equal(response.data.clock.pauseRequested,false);assert.equal(response.data.clock.registrationDelayMs,180000);
  assert.equal(response.data.clock.nextBlindAt-at,remaining);assert.equal(response.data.ready,true);
  const deadline=response.data.clock.nextBlindAt;at+=1000;
  assert.equal((await f.control('pause',{paused:false,pauseVersion:2})).data.clock.nextBlindAt,deadline,'resume retry must not extend the window');
  assert.equal((await f.control('pause',{paused:true,pauseVersion:1})).data.clock.pauseRequested,false,'stale pause cannot undo resume');
  assert.equal(f.moneyCalls(),0);
});

test('automatic pause retains previous blinds across reload and resumes at the next level once',async()=>{
 const f=await fixture(),start=Date.now();let at=start;f.runtime.clock=()=>at;
 const s=await f.start(2,{startedAt:start,lateSeconds:300,levels:[{type:1,min:5,max:10,interval:60},{type:2},{type:1,min:10,max:20,interval:0}]});
 const table=f.runtime.registry.getTable(s.data.tables[0].room_id,1,'holdem');table.hand={};table.phase='playing';
 at+=61000;let result=(await f.control('status')).data;assert.equal(result.clock.pauseRequested,true);assert.equal(result.clock.pauseAt,null);assert.equal(result.clock.bigBlind,10);assert.equal(result.clock.pauseVersion,1);
 assert.equal((await f.control('pause',{paused:false,pauseVersion:2})).code,409);
 table.hand=null;table.phase='idle';table.mtt.paused=true;table.startAt=at+3000;at+=3000;
 result=(await f.control('status')).data;assert.equal(result.clock.pauseAt,at);assert.equal(result.ready,false);
 await f.reload();at+=120000;assert.equal((await f.control('status')).data.clock.bigBlind,10);
 result=(await f.control('pause',{paused:false,pauseVersion:2})).data;
 assert.equal(result.clock.bigBlind,20);assert.equal(result.clock.completedPauseIndex,1);assert.equal(result.clock.pauseRequested,false);assert.equal(result.clock.registrationDelayMs,120000);assert.equal(result.ready,true);
 const delay=result.clock.registrationDelayMs;
 assert.equal((await f.control('pause',{paused:false,pauseVersion:2})).data.clock.registrationDelayMs,delay);
 assert.equal((await f.control('status')).data.clock.autoPauseIndex,null);
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

test('native tournament rest blocks the next hand, survives reload, and sends remaining seconds on rejoin',async()=>{
  const f=await fixture(),s=await f.start(2,{levels:[{type:1,min:5,max:10,bet:0,interval:60},{type:3,min:0,max:0,bet:0,interval:10},{type:1,min:10,max:20,bet:0,interval:0}]});
  assert.equal(s.code,200);const table=f.runtime.registry.getTable(s.data.tables[0].room_id,1,'holdem');
  const peer=await f.join(10001,table.roomId);table.mtt.config.startedAt=Date.now()-61000;table.startAt=0;
  await f.tick();assert.equal(table.hand,null);assert.equal(table.mtt.paused,true);
  const rest=peer.messages.find(m=>m.msgid===20014);assert.equal(rest.payload,10);
  assert.equal((await f.control('status')).data.ready,false);
  const clock=table.mtt.clock,until=clock.restUntil;await f.reload();assert.equal(table.mtt.clock,clock);assert.equal(clock.restUntil,until);
  await f.request(peer,SEND.LOGIN_ROOM);assert.ok(peer.messages.filter(m=>m.msgid===20014).length>=2);
  // Advance the shared clock to the exact end without waiting in real time.
  f.runtime.clock=()=>until;await f.tick();assert.equal((await f.control('status')).data.ready,true);
  assert.equal(table.mtt.paused,true,'rank checkpoint precedes the next hand');
  assert.equal((await f.control('advance',{revision:0,ranks:{}})).code,200);
  assert.equal(table.mtt.clock.waitingIndex,undefined);assert.equal(f.moneyCalls(),0);
});

test('finished tables reclaim only after complete award notification; repeated cleanup never cashes competition chips',async()=>{
  const f=await fixture(),s=await f.start(2),room=s.data.tables[0].room_id;
  const peer=await f.join(10001,room),table=f.runtime.registry.getTable(room,1,'holdem');
  table.mtt.paused=true;table.phase='idle';table.startAt=0;table.members[0].point=200;table.members[1].point=0;
  await f.control('advance',{revision:0,ranks:{}});
  assert.equal((await f.control('cleanup')).code,409);assert.equal(f.runtime.registry.tables.size,1);
  const results=[{uid:10001,rank:1,award:50,ticketNum:0},{uid:10002,rank:2,award:0,ticketNum:0}];
  assert.equal((await f.control('awards',{results:results.slice(0,1)})).code,400);
  assert.equal((await f.control('awards',{results:results.map(item=>({...item,rank:1}))})).code,400,'tied final ranks cannot be acknowledged');
  assert.equal((await f.control('awards',{results})).code,200);
  assert.equal(peer.messages.filter(m=>m.msgid===20010).length,1);
  const scheduled=await f.control('cleanup');assert.equal(scheduled.data.released,false);
  const deadline=scheduled.data.cleanupAt;await f.reload();assert.equal((await f.control('cleanup')).data.cleanupAt,deadline);
  await f.request(peer,SEND.LOGIN_ROOM);assert.equal(peer.messages.filter(m=>m.msgid===20010).length,2,'rejoin restores the paid final result');
  const session=f.runtime.registry.session(peer.ws);session.leaveTask=Promise.resolve();session.roomLeave={table};
  f.runtime.clock=()=>deadline;await f.tick();assert.equal(f.runtime.registry.tables.size,1,'in-flight departure postpones reclaim');
  delete session.leaveTask;delete session.roomLeave;await f.tick();
  assert.equal(f.runtime.registry.tables.size,0);assert.equal(f.runtime.registry.roomManager.size,0);
  assert.equal(f.runtime.tournamentRooms.matches.size,0);assert.equal(table.members.length,0);
  assert.equal(f.runtime.registry.session(peer.ws).inRoom,false);assert.ok(peer.messages.some(m=>m.msgid===PUSH.ROOM_DISSMISS));
  assert.equal((await f.control('cleanup')).data.released,true);assert.equal(f.moneyCalls(),0);
});

test('production rejects a terminal match start even after the short response cache has expired',async()=>{
  const runtime={env:'prod',config:{match_control_secret:'private'},registry:createRegistry(),rpc:{lobby:{getMatch:async()=>({id:99,agent_id:1,state:3})}}};
  const control=await createTournamentControl(runtime,()=>assert.fail('terminal match cannot allocate a game'),()=>({}));
  const responses=[],ws={readyState:1,send:raw=>responses.push(JSON.parse(String(raw)))};
  await control.handle(ws,signControl('private',{action:'start',agentId:1,matchId:99}));
  assert.equal(responses[0].code,409);assert.equal(runtime.registry.tables.size,0);
});

test('signed invalidation aborts virtual tournament chips without settlement or cash-out',async()=>{
  const f=await fixture(),s=await f.start(2),room=s.data.tables[0].room_id,peer=await f.join(10001,room);
  const table=f.runtime.registry.getTable(room,1,'holdem');table.startAt=0;await f.tick();assert.ok(table.hand);
  const processId=(await f.control('status')).data.processId;await f.reload();assert.equal((await f.control('status')).data.processId,processId);
  const response=await f.control('invalidate');assert.equal(response.code,200);assert.equal(response.data.invalidated,true);
  assert.equal(table.hand,null);assert.equal(f.runtime.registry.tables.size,0);assert.equal(f.runtime.tournamentRooms.matches.size,0);
  assert.equal(f.moneyCalls(),0);assert.ok(peer.messages.some(m=>m.msgid===PUSH.ROOM_DISSMISS));
  assert.equal((await f.control('invalidate')).data.released,true);
  assert.equal((await f.control('status')).reason,'MATCH_STATE_LOST');
});

test('late admission adds original starting points once at a hand boundary and repairs seats freed by elimination',async()=>{
  const f=await fixture(),s=await f.start(7),room=s.data.tables[0].room_id,table=f.runtime.registry.getTable(room,1,'holdem');
  const admission={uid:20001,name:'late',icon:'',point:100,key:'match:1:99:20001:1'};
  assert.equal((await f.control('advance',{revision:0,admissions:[admission]})).code,409);
  assert.equal(table.members.length,7);
  table.mtt.paused=true;table.phase='idle';table.startAt=0;
  for(const p of table.members)p.point=0;table.members[0].point=700;
  const result=await f.control('advance',{revision:0,admissions:[admission],ranks:{}});
  assert.equal(result.code,200);assert.equal(result.data.finished,false);assert.equal(result.data.players.reduce((n,p)=>n+p.point,0),800);
  const late=table.members.find(p=>p.uid===20001);assert.ok(late.pos>=0);assert.equal(late.point,100);
  const repeated=await f.control('advance',{revision:0,admissions:[admission],ranks:{}});
  assert.equal(repeated.data.players.reduce((n,p)=>n+p.point,0),800);assert.equal(table.members.length,2);
  assert.equal(f.moneyCalls(),0);
});

test('late admission expands a full tournament table only at the checkpoint',async()=>{
  const f=await fixture(),s=await f.start(7),table=f.runtime.registry.getTable(s.data.tables[0].room_id,1,'holdem');
  table.mtt.paused=true;table.phase='idle';table.startAt=0;
  const result=await f.control('advance',{revision:0,ranks:{},admissions:[{uid:20001,point:100,key:'match:1:99:20001:1'}]});
  assert.equal(result.code,200);assert.deepEqual(result.data.tables.map(t=>t.player_nums),[4,4]);
  assert.equal(result.data.players.reduce((n,p)=>n+p.point,0),800);
  for(const t of f.runtime.registry.tables.values())assert.equal(new Set(t.members.map(p=>p.pos)).size,t.members.length);
});

test('a zero-stack participant may reenter once without increasing the unique roster and the last player waits until the window closes',async()=>{
  const f=await fixture(),start=Date.now(),s=await f.start(2,{rebuyLimit:1,lateLevel:2,lateSeconds:120});
  const room=s.data.tables[0].room_id,table=f.runtime.registry.getTable(room,1,'holdem');
  const player=await f.join(10002,room);table.members[0].point=200;table.members[1].point=0;table.phase='idle';table.startAt=0;table.mtt.paused=true;
  const waiting=await f.control('advance',{revision:0,ranks:{}});assert.equal(waiting.data.finished,false);assert.equal(waiting.data.waitingForReentry,true);
  const request={revision:1,ranks:{},admissions:[{uid:10002,point:100,key:'match:1:99:10002:2',reentry:true,reentryNumber:1}]};
  const result=await f.control('advance',request);assert.equal(result.code,200);assert.equal(result.data.waitingForReentry,false);
  assert.equal(result.data.players.reduce((n,p)=>n+p.point,0),300);assert.equal(f.runtime.tournamentRooms.matches.get('1:99').roster.length,2);
  assert.equal((await f.control('advance',request)).data.players.reduce((n,p)=>n+p.point,0),300);
  await f.request(player,SEND.LOGIN_ROOM);assert.equal(player.messages.filter(m=>m.msgid===4199).at(-1).payload,0);
  table.members.find(p=>p.uid===10001).point=300;table.members.find(p=>p.uid===10002).point=0;table.phase='idle';table.startAt=0;table.mtt.paused=true;
  assert.equal((await f.control('advance',{revision:2,ranks:{},admissions:[{...request.admissions[0],key:'match:1:99:10002:3',reentryNumber:2}]})).code,409);
  f.runtime.clock=()=>start+121000;
  assert.equal((await f.control('advance',{revision:2,ranks:{}})).data.finished,true);assert.equal(f.moneyCalls(),0);
});
