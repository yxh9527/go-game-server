import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry,findConfig} from '../../game-server/src/registry.js';
import {createWallet} from '../../game-server/src/wallet/index.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {SEND,PUSH} from '../../game-server/src/messages.js';

test('client room IDs cannot create unconfigured rooms or jump the room allocation sequence',async()=>{
  const registry=createRegistry(),configs=seedRooms(),frames=[];
  const runtime={env:'dev',hotVersion:'room-identity-security',registry,configs,findConfig,
    wallet:createWallet({mode:'local',local_balance:10000}),log:{info(){},error(){}}};
  const handler=await createHandler(runtime),ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
  registry.bind(ws,{userId:42,agentId:7,authenticated:true,inRoom:false,wallet:10000});
  const cfg=configs.find(row=>Number(row.room_type)===25),base=Number(cfg.game_room_config_id)*10000;
  for(const roomId of [-1,Number.MAX_SAFE_INTEGER+1,base+9999,99000000,base+1]){
    await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId,roomType:25}));
    assert.equal(registry.tables.size,0);
  }
  await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId:base,roomType:24}));assert.equal(registry.tables.size,0);
  await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId:base,roomType:25}));
  assert.equal(registry.tables.size,1);assert.ok(frames.some(r=>r.msgid===PUSH.ROOM_TYPE_RESULT));
  assert.ok(![...registry.roomPoolState.nextIndexes.values()].some(index=>index>=10000));
});

test('already allocated Mahjong rooms cannot be entered as another Mahjong family',async()=>{
  const registry=createRegistry(),configs=seedRooms(),runtime={env:'dev',hotVersion:'mahjong-room-identity',registry,configs,findConfig,
    wallet:createWallet({mode:'local',local_balance:10000}),log:{info(){},error(){}}};
  const handler=await createHandler(runtime),frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
  const session={userId:42,agentId:7,authenticated:true,inRoom:false,wallet:10000};registry.bind(ws,session);
  const cfg=configs.find(row=>Number(row.room_type)===26),roomId=Number(cfg.game_room_config_id)*10000;
  await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId,roomType:26}));assert.equal(session.inRoom,true);
  await handler.onMessage(ws,encodeFrame(SEND.SEND_LEVEL_OUT));frames.length=0;
  await handler.onMessage(ws,encodeFrame(SEND.SEND_JOIN_ROOM,{roomId,roomType:30}));
  assert.equal(session.inRoom,false);assert.equal(frames.some(r=>r.msgid===PUSH.ROOM_TYPE_RESULT),false);
});
