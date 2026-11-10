import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame,MAX_FRAME_BYTES} from '../../game-server/src/codec.js';
import {SEND,PUSH} from '../../game-server/src/messages.js';

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
