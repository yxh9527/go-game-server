import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sessionFixture,sessionRuntime} from '../fixtures/hot-session-control.mjs';

test('replacement preserves a pending login and socket state without starting another login',async()=>{
  const f=sessionFixture(),x=sessionRuntime(),ws=x.socket();let release;
  try{
    f.write(0);const old=(await f.load('session-control.js',0)).createSessionControl(x.runtime,x.hooks(0));let calls=0;
    const pending=old.begin(ws,async()=>{calls++;await new Promise(resolve=>{release=resolve;});return 'accepted';},42);await new Promise(resolve=>setImmediate(resolve));
    const state=x.runtime.sessionControl,socket=old.socketState(ws),sequence=state.sequence;
    f.write(1);const next=(await f.load('session-control.js',1)).createSessionControl(x.runtime,x.hooks(1));
    assert.equal(next.begin(ws,()=>assert.fail('login replayed'),42),pending);assert.equal(next.socketState(ws),socket);assert.equal(x.runtime.sessionControl,state);assert.equal(state.sequence,sequence);
    release();assert.equal(await pending,'accepted');assert.equal(calls,1);assert.equal(state.pendingLogins.size,0);assert.equal(socket.loginTask,undefined);assert.equal(ws.readyState,1);
  }finally{release?.();x.runtime.sessionControl?.unsubscribe?.();f.close();}
});

test('the resident revocation callback calls current code, migrates once, and never duplicates subscription',async()=>{
  const f=sessionFixture(),x=sessionRuntime(),ws=x.socket();
  try{
    let legacyUnsubscribed=0;x.runtime.sessionControl={sequence:0,latest:new Map(),queues:new Map(),sockets:new WeakMap(),distributed:x.distributed,unsubscribe:()=>legacyUnsubscribed++};
    f.write(0);const old=(await f.load('session-control.js',0)).createSessionControl(x.runtime,x.hooks(0));const state=x.runtime.sessionControl;
    assert.equal(legacyUnsubscribed,1);assert.equal(x.subscriptions,1);
    f.write(1);const next=(await f.load('session-control.js',1)).createSessionControl(x.runtime,x.hooks(1));assert.equal(state,x.runtime.sessionControl);assert.equal(x.subscriptions,1);assert.equal(x.listeners.size,1);
    const session={userId:42,agentId:7,loginId:'original-login',authenticated:true};x.runtime.registry.bind(ws,session);
    x.emit('{');assert.equal(x.errors.length,1);assert.equal(ws.readyState,1);
    x.emit({event:'revoke',loginId:'another-login'});assert.equal(ws.readyState,1);
    x.emit({event:'revoke',loginId:'original-login'});await new Promise(resolve=>setImmediate(resolve));assert.equal(x.sent.length,1);assert.equal(x.sent[0].revision,1);assert.equal(session.superseded,true);assert.equal(ws.readyState,3);
    assert.equal(old.socketState(ws),next.socketState(ws));
  }finally{x.runtime.sessionControl?.unsubscribe?.();f.close();}
});

test('an in-flight lease claim finishes on its original socket after replacing the controller',async()=>{
  const f=sessionFixture(),x=sessionRuntime(),ws=x.socket();let release,claims=0;
  try{
    x.distributed.claim=()=>{claims++;return new Promise(resolve=>{release=()=>resolve({ok:true,loginId:'original-login',generation:1,role:'primary'});});};
    f.write(0);const old=(await f.load('session-control.js',0)).createSessionControl(x.runtime,x.hooks(0)),session={userId:42,agentId:7,roomId:7};
    const pending=old.accept(ws,session,1);await new Promise(resolve=>setImmediate(resolve));assert.equal(claims,1);
    const queue=x.runtime.sessionControl.queues.get('7:42');f.write(1);const next=(await f.load('session-control.js',1)).createSessionControl(x.runtime,x.hooks(1));assert.equal(x.runtime.sessionControl.queues.get('7:42'),queue);
    release();assert.equal(await pending,true);assert.equal(claims,1);assert.equal(x.runtime.registry.session(ws),session);assert.equal(session.loginId,'original-login');assert.equal(next.socketState(ws).closed,undefined);assert.equal(ws.readyState,1);
  }finally{release?.();x.runtime.sessionControl?.unsubscribe?.();f.close();}
});

test('hall hundred previews remain read-only and filter private fields across replacement',async()=>{
  const f=sessionFixture(),table={roomId:58010000,roomType:58,playMode:0,phaseEndsAt:2000,cfg:{game_room_config_id:5801}},snapshot={state:2,bankerCards:[1],privateDeck:[9],wallet:10000};
  const game={id:'baccarat',kind:'hundred',config:{},enterSnapshot:()=>snapshot};
  try{
    for(let revision=0;revision<2;revision++){
      f.write(revision);const module=await f.load('hundred-lobby.js',revision),result=module.hundredLobbySnapshot(game,table,1000),info=JSON.parse(result.extendInfo);
      assert.equal(info.countDown,1000);assert.deepEqual(info.bankerCards,[1]);assert.equal(info.privateDeck,undefined);assert.equal(info.wallet,undefined);assert.equal(snapshot.countDown,undefined);
      const runtime={configs:[{state:1,room_type:58,game_room_config_id:5801}],registry:{getTable:()=>null,setTable:()=>assert.fail('preview allocated a live room')}};
      assert.equal(module.listHundredLobbyRooms(runtime,()=>game,7).length,1);
      const messages=await f.load('messages.js',revision);assert.equal(messages.SEND.ROOM_LOGIN,1105);assert.equal(messages.SEND.PING,1200);
    }
  }finally{f.close();}
});

test('old session modules are collected while one resident subscriber and socket state survive',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-session-control.mjs','--session-control-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_SESSION_CONTROL_GC/);
});
