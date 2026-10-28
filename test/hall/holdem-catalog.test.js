import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { seedRooms } from '../../cache/rpc/seed.js';
import { createRoomLogic } from '../../hall/src/rooms.js';
import { createApp } from '../../hall/src/create-app.js';
import { requestRoomPool } from '../../hall/src/room-pool.js';
import * as decode from '../../hall/src/decode.js';
import { toClientRoom } from '../../hall/src/to-client.js';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { HoldemGame } from '../../game-server/src/games/holdem/HoldemGame.js';
import { createTexasTable, texasConf, holdemPlayMode } from '../../game-server/src/games/holdem/engine.js';
import { holdemRoomSettings, holdemRoomKey } from '../../shared/holdem-room.js';

const rows = seedRooms(), rooms = createRoomLogic(decode);
const showIds = [70,1921,1,1922,2,1923,3,4,5,1927,121,123,1920];
const noShowIds = [1924,1928,1925,1929,1926,1930];

test('captured forced-show 13 and no-show 6 catalogs retain every mode, tier and unique full key', () => {
  for (const [show, ids] of [[true,showIds],[false,noShowIds]]) {
    const selected = rooms.filterRooms(rows, { gameType:19, forceShowCard:show });
    assert.deepEqual(selected.map(r=>r.game_room_config_id), ids);
    for (const row of selected) {
      const p=toClientRoom(row), entered=rooms.enterRoomPayload(row, p, {});
      assert.equal(rooms.findRoom(rows,p),row); assert.equal(p.key,holdemRoomKey(row));
      assert.equal(p.key,entered.key);
      for(const key of ['smallBlind','bigBlind','carryMin','straddle','initialBet','roomClassification','playMode','aofBet','forceShowCard'])
        assert.equal(entered[key],p[key],`${row.game_room_config_id} ${key}`);
      assert.equal(p.straddle,p.playMode===8);
      assert.equal(p.initialBet,p.playMode===8?0:p.bigBlind);
      assert.equal(p.aofBet,p.playMode===8?p.carryMin:0);
    }
  }
  const texas=rows.filter(r=>r.room_type===19);
  assert.equal(new Set(texas.map(r=>JSON.parse(r.payload).key)).size,19);
  assert.equal(rooms.filterRooms(rows,{gameType:19,forceShowCard:true,playMode:0}).length,6);
  assert.equal(rooms.filterRooms(rows,{gameType:19,forceShowCard:true,playMode:2}).length,3);
  assert.equal(rooms.filterRooms(rows,{gameType:19,forceShowCard:true,playMode:8}).length,4);
});

test('full holdem identity rejects mismatched category, carry, straddle, initial and fixed wagers', () => {
  for (const row of rows.filter(r=>r.room_type===19)) {
    const p=JSON.parse(row.payload);
    for (const key of ['carryMin','roomClassification','initialBet','aofBet','ante','seeCardNo'])
      assert.equal(rooms.findRoom(rows,{...p,[key]:p[key]+1}),null,`${row.game_room_config_id} ${key}`);
    assert.equal(rooms.findRoom(rows,{...p,straddle:!p.straddle}),null);
    assert.equal(rooms.findRoom(rows,{...p,key:p.key+'/wrong'}),null);
    const {gameRoomConfigId,...withoutId}=p;
    assert.equal(rooms.findRoom(rows,withoutId),row);
  }
});

test('ordinary high-blind rooms inherit their captured category and special engines cannot silently play normal rules', () => {
  const game=new HoldemGame();
  assert.deepEqual(holdemRoomSettings(null),holdemRoomSettings());
  assert.deepEqual(holdemRoomSettings({payload:'null'}),holdemRoomSettings());
  assert.equal(game.createTable(700000,19,null).bigBlind,20);
  for(const row of rows.filter(r=>r.room_type===19)) {
    if([0,2].includes(row.play_mode)) {
      for(const table of [game.createTable(row.game_room_config_id*10000,19,row),createTexasTable(row.game_room_config_id*10000,19,row)]) {
        assert.equal(texasConf(table).roomClassification,JSON.parse(row.payload).roomClassification);
        assert.equal(table.forceShowCard,!!row.force_show_card); assert.equal(table.playMode,row.play_mode+1);
        assert.equal(texasConf(table).dzpk.criticalFlag,row.play_mode===2);
      }
    } else {
      assert.throws(()=>game.createTable(row.game_room_config_id*10000,19,row),e=>e.code===503&&/尚未开放/.test(e.message));
      assert.throws(()=>createTexasTable(row.game_room_config_id*10000,19,row),e=>e.code===503);
    }
  }
  assert.equal(holdemPlayMode({play_mode:2},19),3);assert.equal(holdemPlayMode({play_mode:8},19),9);
  assert.equal(holdemPlayMode({play_mode:2},101),2);
  const persisted={room_type:19,play_mode:8,payload:JSON.stringify({straddle:true,initialBet:0,roomClassification:4,aofBet:500})};
  assert.equal(holdemRoomSettings(persisted).initialBet,0);assert.equal(holdemRoomSettings(persisted).aofBet,500);
});

test('real op38/op45 list all tiers, allocate correct ordinary rooms and reject unopened modes before creating rooms', async t => {
  const registry=createRegistry(), runtime={env:'dev',hotVersion:'holdem-catalog',configs:rows,registry,findConfig,
    gateway:{validateToken:async(token,uid)=>token==='test-'+uid,getLoginData:async()=>({agentId:17})},
    wallet:{async load(s){s.wallet=1000000;},async persist(){}}, log:{info(){},error(){}}};
  const handler=await createHandler(runtime), gameServer=http.createServer(), sockets=new WebSocketServer({server:gameServer});
  const failures=[];
  sockets.on('connection',ws=>{ws.on('message',raw=>handler.onMessage(ws,raw).catch(e=>failures.push(e)));ws.on('close',()=>handler.onClose(ws).catch(e=>failures.push(e)));});
  await new Promise(resolve=>gameServer.listen(0,'127.0.0.1',resolve));
  const hallRuntime={env:'dev',hotVersion:'holdem-catalog',config:{game_server:'127.0.0.1:'+gameServer.address().port},
    roomStore:{list:()=>rows},matchStore:{listMatches:()=>[]},rpc:{lobby:{},common:{}},log:runtime.log};
  const server=http.createServer(await createApp(hallRuntime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const ws of sockets.clients)ws.terminate();await new Promise(r=>sockets.close(r));
    await Promise.all([new Promise(r=>gameServer.close(r)),new Promise(r=>server.close(r))]);});
  const query=async(op,fields)=>{const param=Buffer.from(new URLSearchParams(fields).toString()).toString('base64');
    return (await fetch('http://127.0.0.1:'+server.address().port+'/api/internal/v1/do?'+new URLSearchParams({op,userId:1717,token:'test-1717',param}))).json();};
  for(const [show,ids] of [[1,showIds],[0,noShowIds]]) {
    const result=await query(38,{gameType:19,forceShowCard:show});
    assert.equal(result.msgCode,200);assert.deepEqual(result.data[0].roomInfoData.map(p=>p.gameRoomConfigId),ids);
    assert.ok(result.data[0].roomInfoData.every(p=>Number.isInteger(p.totalPeople)&&p.totalPeople<=100));
  }
  assert.equal(registry.tables.size,0,'listing never creates rooms');
  for(const row of rows.filter(r=>r.room_type===19)) {
    const payload=JSON.parse(row.payload), before=registry.tables.size;const result=await query(45,payload);
    if([0,2].includes(row.play_mode)){assert.equal(result.msgCode,200);assert.equal(result.data.gameRoomConfigId,row.game_room_config_id);
      assert.equal(result.data.playMode,row.play_mode+1);assert.equal(result.data.key,payload.key);
      const table=registry.getTable(result.data.roomId,17,'holdem');assert.ok(table);assert.equal(table.members.length,0);
      assert.equal(table.cfg.game_room_config_id,row.game_room_config_id);assert.equal(table.roomClassification,payload.roomClassification);
    }else{assert.equal(result.msgCode,503);assert.match(result.errMsg,/尚未开放/);assert.equal(result.data,null);assert.equal(registry.tables.size,before);}
  }
  await assert.rejects(requestRoomPool(hallRuntime,{userId:1717,token:'test-1717'},'allocate',{gameRoomConfigId:1927,roomType:19}),/AOF必推玩法尚未开放/);
  assert.equal(registry.tables.size,15);assert.deepEqual(failures,[]);
});
