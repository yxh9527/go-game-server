import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../../hall/src/create-app.js';
import {createMatchStore,createRoomStore} from '../../hall/src/store.js';

test('production hall refuses missing and frozen financial game mappings before returning room credentials',async t=>{
  let calls=0,routes=[];
  const roomStore=createRoomStore();roomStore.replace([{game_type:1004,room_type:61,game_room_config_id:6101,carry_min:500,state:1}]);
  const runtime={env:'prod',hotVersion:'route-entry',config:{game_server:'127.0.0.1:11041'},log:{error(){}},
    matchStore:createMatchStore(),roomStore,rpc:{lobby:{async listFinanceGames(){calls++;return routes;}}}};
  const request=async()=>{
    const server=http.createServer(await createApp(runtime));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{return await (await fetch('http://127.0.0.1:'+server.address().port+'/api/internal/v1/do?op=45&roomType=61&gameRoomConfigId=6101')).json();}
    finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  };
  assert.equal((await request()).msgCode,503);
  routes=[{gameType:1004,roomType:61,number:91003,symbol:'test_scratch_mj',state:2,isFrozen:0}];
  assert.equal((await request()).msgCode,503);
  routes[0]={...routes[0],state:1};
  const body=await request();assert.equal(body.msgCode,200);assert.equal(body.data.roomType,61);
  assert.equal(calls,3,'each business reload loads a single trusted catalogue snapshot');
});
