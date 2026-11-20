import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame,MAX_FRAME_BYTES} from '../../game-server/src/codec.js';
import {SEND,PUSH} from '../../game-server/src/messages.js';
import {GAME_SESSION_STORE_VERSION} from '../../shared/rpc/game-session-store.js';

async function fixture(){
  const registry=createRegistry(),frames=[],closes=[];
  const ws={readyState:1,send:raw=>frames.push(decodeFrame(raw)),close:(code,reason)=>closes.push({code,reason})};
  const runtime={env:'dev',hotVersion:'request-limits',registry,configs:[],findConfig:()=>null,
    wallet:{authoritative:true,run(){assert.fail('heartbeat/oversize must not enter a monetary transaction');}},
    log:{info(){},warn(){},error(){}}};
  registry.bind(ws,{userId:42,agentId:7,inRoom:false,authenticated:true});
  const handler=await createHandler(runtime);return {runtime,registry,frames,closes,ws,handler};
}
test('empty heartbeats avoid global wallet reads and room snapshots',async()=>{
  const f=await fixture();
  await f.handler.onMessage(f.ws,encodeFrame(SEND.PING));
  await f.handler.onMessage(f.ws,encodeFrame(SEND.ROOM_PING));
  assert.deepEqual(f.frames.map(r=>r.msgid),[PUSH.PING,PUSH.ROOM_PING]);assert.equal(f.closes.length,0);
});
test('oversized packets are rejected before a wallet or game operation',async()=>{
  const f=await fixture();await f.handler.onMessage(f.ws,Buffer.alloc(MAX_FRAME_BYTES+1));
  assert.equal(f.closes[0].code,1009);assert.equal(f.frames.length,0);
});
test('blocked wallet RPC work has a per-socket queue ceiling, including repeated logins',async()=>{
  for(const id of [SEND.SEARCH_MY_POINT,SEND.ROOM_LOGIN]){
    const f=await fixture();let release,calls=0;
    const gate=new Promise(resolve=>{release=resolve;});f.runtime.wallet.run=()=>{calls++;return gate;};
    const tasks=Array.from({length:1000},()=>f.handler.onMessage(f.ws,encodeFrame(id,{userId:42})));
    assert.equal(calls,64);assert.equal(f.closes.length,1);assert.equal(f.closes[0].code,1008);
    release();await Promise.all(tasks);assert.equal(f.runtime.sessionControl.sockets.get(f.ws).pendingMessages,0);
  }
});
test('completed requests release queue capacity and cannot disable monetary handling',async()=>{
  const f=await fixture();let calls=0;f.runtime.wallet.run=async()=>{calls++;};
  for(let i=0;i<100;i++)await f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));
  assert.equal(calls,100);assert.equal(f.closes.length,0);
  assert.equal(f.runtime.sessionControl.sockets.get(f.ws).pendingMessages,0);
});

test('many sockets share one bounded client cash queue while heartbeat remains available',async()=>{
  const f=await fixture(),sockets=[];let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});f.runtime.wallet.run=()=>{calls++;return gate;};
  for(let index=0;index<300;index++){
    const frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw)),close(){assert.fail('global capacity must not close existing connections');}};
    f.registry.bind(ws,{userId:1000+index,agentId:7,authenticated:true,inRoom:false});sockets.push({ws,frames});
  }
  const tasks=sockets.map(({ws})=>f.handler.onMessage(ws,encodeFrame(SEND.SEARCH_MY_POINT)));
  assert.equal(calls,256);assert.equal(f.runtime.cashRequestAdmission.pending,256);
  assert.equal(sockets.filter(({frames})=>frames.some(frame=>frame.msgid===9999&&frame.payload.errorMsg.includes('稍后重试'))).length,44);
  await f.handler.onMessage(sockets[299].ws,encodeFrame(SEND.PING));assert.equal(sockets[299].frames.at(-1).msgid,PUSH.PING);assert.equal(calls,256);
  assert.equal(f.runtime.sessionControl.sockets.get(sockets[299].ws).pendingMessages,0);
  release();await Promise.all(tasks);assert.equal(f.runtime.cashRequestAdmission.pending,0);
  for(const {ws}of sockets)assert.equal(f.runtime.sessionControl.sockets.get(ws).pendingMessages||0,0);
  await f.handler.onMessage(sockets[299].ws,encodeFrame(SEND.SEARCH_MY_POINT));assert.equal(calls,257);assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('hot replacement shares pending client capacity and cannot bypass an older handler queue',async()=>{
  const f=await fixture();let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});f.runtime.wallet.run=()=>{calls++;return gate;};
  const sockets=Array.from({length:5},(_,index)=>{
    const frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw)),close(){}};f.registry.bind(ws,{userId:100+index,agentId:7,authenticated:true,inRoom:false});return {ws,frames};
  });
  const accepted=[];for(const {ws}of sockets.slice(0,4))for(let i=0;i<64;i++)accepted.push(f.handler.onMessage(ws,encodeFrame(SEND.SEARCH_MY_POINT)));
  const owner=f.runtime.cashRequestAdmission;f.runtime.hotVersion+='-next';const next=await createHandler(f.runtime);
  await next.onMessage(sockets[4].ws,encodeFrame(SEND.SEARCH_MY_POINT));assert.equal(f.runtime.cashRequestAdmission,owner);assert.equal(owner.pending,256);assert.equal(calls,256);assert.equal(sockets[4].frames.at(-1).msgid,9999);
  release();await Promise.all(accepted);assert.equal(owner.pending,0);await next.onMessage(sockets[4].ws,encodeFrame(SEND.SEARCH_MY_POINT));assert.equal(calls,257);assert.equal(owner.pending,0);
});

test('synchronous wallet errors and rejected queued actions release both instance and socket admission counts',async()=>{
  for(const immediate of [true,false]){
    const f=await fixture();f.runtime.wallet.run=()=>{if(immediate)throw Error('cash queue failure');return Promise.reject(Error('cash queue failure'));};
    await assert.rejects(f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT)),/cash queue failure/);
    assert.equal(f.runtime.cashRequestAdmission.pending,0);assert.equal(f.runtime.sessionControl.sockets.get(f.ws).pendingMessages,0);
    f.runtime.wallet.run=async()=>{};await f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));assert.equal(f.runtime.cashRequestAdmission.pending,0);
  }
});

test('session coordination waits count toward global admission before any wallet action begins',async()=>{
  const f=await fixture();let release,claims=0,calls=0;const gate=new Promise(resolve=>{release=resolve;});
  const store={coordinationVersion:GAME_SESSION_STORE_VERSION,instanceId:'admission-lease',subscribe(){return ()=>{};},async withSession(session,action){claims++;await gate;return action();}};
  f.runtime.bus={gameSessions:store};f.runtime.wallet.run=async()=>{calls++;};f.runtime.hotVersion+='-lease';const handler=await createHandler(f.runtime);
  const accepted=[];for(let index=0;index<257;index++){
    const ws={readyState:1,send(){},close(){}};f.registry.bind(ws,{userId:1000+index,agentId:7,authenticated:true,inRoom:false,loginId:'login-'+index});accepted.push(handler.onMessage(ws,encodeFrame(SEND.SEARCH_MY_POINT)));
  }
  assert.equal(claims,256);assert.equal(calls,0);assert.equal(f.runtime.cashRequestAdmission.pending,256);release();await Promise.all(accepted);assert.equal(calls,256);assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('full client admission does not reject resident settlement ticks or disconnect cleanup',async()=>{
  const f=await fixture();let release,calls=0;const gate=new Promise(resolve=>{release=resolve;});f.runtime.wallet.run=()=>{calls++;return gate;};
  f.runtime.wallet.managed=()=>false;
  const accepted=[];for(let i=0;i<256;i++){
    const ws={readyState:1,send(){},close(){}};f.registry.bind(ws,{userId:1000+i,agentId:7,authenticated:true,inRoom:false});accepted.push(f.handler.onMessage(ws,encodeFrame(SEND.SEARCH_MY_POINT)));
  }
  assert.equal(calls,256);assert.equal(f.runtime.cashRequestAdmission.pending,256);
  f.registry.setTable(700001,{roomId:700001,roomType:19,agentId:7,gameId:'holdem',members:[],observers:[]},7,'holdem');
  const ticking=f.handler.tick(),closing=f.handler.onClose(f.ws);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,258,'tick or close cleanup was denied by client capacity');assert.equal(f.runtime.cashRequestAdmission.pending,256);
  release();await Promise.all([...accepted,ticking,closing]);assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('requests waiting on room join do not act after their original connection or session is invalidated',async()=>{
  for(const change of ['closed','unauthenticated','rebound','removed']){
    const f=await fixture(),session=f.registry.session(f.ws);let release,cleanups=0;
    const game=f.handler.games.byRoomType.get(19),original=game.afterRound;game.afterRound=()=>{cleanups++;};
    try{
      const table=game.createTable(700001,19,{small_blind:5,big_blind:10,carry_min:100});table.agentId=7;f.registry.setTable(table.roomId,table,7,'holdem');
      Object.assign(session,{roomId:table.roomId,gameId:'holdem',inRoom:true,wallet:1000});session.roomJoinTask=new Promise(resolve=>{release=resolve;});
      f.runtime.wallet.run=async action=>action();const pending=f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));
      await new Promise(resolve=>setImmediate(resolve));
      if(change==='closed')f.runtime.sessionControl.sockets.get(f.ws).closed=true;
      if(change==='unauthenticated')session.authenticated=false;
      if(change==='rebound')f.registry.bind(f.ws,{...session,userId:43});
      if(change==='removed')f.registry.drop(f.ws);
      release();await pending;assert.equal(cleanups,0,'invalidated request entered the game: '+change);assert.equal(f.frames.length,0,'invalidated request received a business reply: '+change);assert.equal(f.runtime.cashRequestAdmission.pending,0);
    }finally{game.afterRound=original;}
  }
});

test('closing a queued connection prevents delayed login or game work before message processing starts',async()=>{
  for(const id of [SEND.ROOM_LOGIN,SEND.SEARCH_MY_POINT]){
    const f=await fixture();let queued,loads=0;f.runtime.wallet.run=action=>new Promise(resolve=>{queued=async()=>resolve(await action());});f.runtime.wallet.load=async()=>{loads++;};
    const pending=f.handler.onMessage(f.ws,encodeFrame(id,{userId:42}));f.runtime.sessionControl.sockets.get(f.ws).closed=true;
    await queued();await pending;assert.equal(loads,0);assert.equal(f.frames.length,0);assert.equal(f.runtime.cashRequestAdmission.pending,0);assert.equal(f.runtime.sessionControl.sockets.get(f.ws).pendingMessages,0);
  }
});

test('a delayed previous-round cleanup cannot continue a new request for an invalidated original session',async()=>{
  for(const id of [SEND.SEARCH_MY_POINT,SEND.LOGIN_ROOM])for(const change of ['closed','unauthenticated','superseded','rebound','removed']){
    const f=await fixture(),session=f.registry.session(f.ws),game=f.handler.games.byRoomType.get(19),original=game.afterRound;let release,entered;
    const ready=new Promise(resolve=>{entered=resolve;});game.afterRound=async()=>{entered();await new Promise(resolve=>{release=resolve;});};
    try{
      const table=game.createTable(700001,19,{small_blind:5,big_blind:10,carry_min:100});table.agentId=7;f.registry.setTable(table.roomId,table,7,'holdem');Object.assign(session,{roomId:table.roomId,gameId:'holdem',inRoom:true,wallet:1000});
      f.runtime.wallet.run=async action=>action();const pending=f.handler.onMessage(f.ws,encodeFrame(id));await ready;
      if(change==='closed')f.runtime.sessionControl.sockets.get(f.ws).closed=true;
      if(change==='unauthenticated')session.authenticated=false;
      if(change==='superseded')session.superseded=true;
      if(change==='rebound')f.registry.bind(f.ws,{...session,userId:43});
      if(change==='removed')f.registry.drop(f.ws);
      release();await pending;assert.equal(f.frames.length,0,'stale previous-round waiter continued: '+change);assert.equal(f.runtime.cashRequestAdmission.pending,0);
    }finally{game.afterRound=original;}
  }
});

test('an unchanged active session still completes a request after waiting for room join',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws),game=f.handler.games.byRoomType.get(19),original=game.afterRound;let release,cleanups=0;game.afterRound=()=>{cleanups++;};
  try{
    const table=game.createTable(700001,19,{small_blind:5,big_blind:10,carry_min:100});table.agentId=7;f.registry.setTable(table.roomId,table,7,'holdem');Object.assign(session,{roomId:table.roomId,gameId:'holdem',inRoom:true,wallet:1000});session.roomJoinTask=new Promise(resolve=>{release=resolve;});
    f.runtime.wallet.run=async action=>action();const pending=f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.frames.length,0);release();await pending;
    assert.equal(cleanups,1);assert.ok(f.frames.length>0);assert.equal(f.runtime.cashRequestAdmission.pending,0);
  }finally{game.afterRound=original;}
});

test('a finished original join waiter is removed so its restored promise cannot trap later joins',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws);let release;
  const task=new Promise(resolve=>{release=resolve;});session.roomJoinTask=task;f.runtime.wallet.run=async action=>action();
  const pending=f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));await new Promise(resolve=>setImmediate(resolve));release();await pending;
  assert.equal(session.roomJoinTask,undefined,'completed join promise stayed attached');assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('a failed original join waiter is cleared and does not permanently reject later messages',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws);let reject;
  session.roomJoinTask=new Promise((resolve,fail)=>{reject=fail;});f.runtime.wallet.run=async action=>action();
  const pending=f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT)),finished=assert.rejects(pending,/original join failed/);await new Promise(resolve=>setImmediate(resolve));reject(Error('original join failed'));await finished;
  assert.equal(session.roomJoinTask,undefined);assert.equal(f.runtime.cashRequestAdmission.pending,0);
  await f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT));assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('finishing an older join wait cannot clear a newer in-flight join task',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws);let release,releaseNew,completed=false;
  const original=new Promise(resolve=>{release=resolve;}),newer=new Promise(resolve=>{releaseNew=resolve;});session.roomJoinTask=original;f.runtime.wallet.run=async action=>action();
  const pending=f.handler.onMessage(f.ws,encodeFrame(SEND.SEARCH_MY_POINT)).then(()=>{completed=true;});await new Promise(resolve=>setImmediate(resolve));session.roomJoinTask=newer;release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(session.roomJoinTask,newer);assert.equal(completed,false);releaseNew();await pending;assert.equal(session.roomJoinTask,undefined);assert.equal(f.runtime.cashRequestAdmission.pending,0);
});

test('a restored already-resolved join promise cannot trap an actual subsequent join request',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws);session.roomJoinTask=Promise.resolve();f.runtime.wallet.run=async action=>action();
  await assert.rejects(f.handler.onMessage(f.ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId:99999999,roomType:99999})),/no game for roomType/);
  assert.equal(session.roomJoinTask,undefined);assert.equal(f.runtime.cashRequestAdmission.pending,0);assert.equal(f.registry.tables.size,0);
});

test('disconnect cleanup continues after a failed pending join and removes the old registry session',async()=>{
  const f=await fixture(),session=f.registry.session(f.ws),logs=[];let reject;
  f.runtime.log.error=(...args)=>logs.push(args);f.runtime.wallet.run=async action=>action();f.runtime.wallet.persist=async()=>{};
  session.inRoom=false;session.roomJoinTask=new Promise((resolve,fail)=>{reject=fail;});
  const closing=f.handler.onClose(f.ws);await new Promise(resolve=>setImmediate(resolve));reject(Error('join failed before disconnect'));
  await closing;assert.equal(session.roomJoinTask,undefined);assert.equal(f.registry.session(f.ws),null);assert.equal(logs.length,1);assert.equal(f.runtime.sessionControl.sockets.get(f.ws).closeTask,undefined);
});
