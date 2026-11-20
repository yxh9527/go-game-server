import {importHotModule} from "../../../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {list}=await importHotModule(new URL("../../../../game-server/src/games/ggl-core/history.js",import.meta.url).href,"history-selected-test/game-server/games/ggl-core/history.test.js");
import {createRpcScratchTickets} from '../../../../game-server/src/games/ggl-core/rpc-tickets.js';
import {createGameRouteIndex} from '../../../../shared/rpc/game-routes.js';
import config from '../../../../game-server/src/games/ggl-mjhl/config.js';

function fixture(){
  let now=0;const cache=new Map(),queries=[],writes=[];
  const table={agentId:7,roomType:61,roomId:61010026,gameRoomId:62010026,config,cfg:{game_type:1004,finance_level:1}};
  const session={agentId:7,userId:42,currency:'CNY'};
  const winInfo={serialNo:'original',faceValue:100,amount:-100,huCount:0,multiplier:0,huMask:Array(20).fill(2)};
  const row={agentId:7,userId:42,currency:'CNY',gameId:91061,log:JSON.stringify({...winInfo,roomId:table.roomId,gameRoomId:table.gameRoomId,roomType:61})};
  let records=[row];
  const runtime={rpc:{bus:{getCache:async key=>{const item=cache.get(key);return item&&item.expiry>now?item.value:null;},
    setCache:async(key,value,ttl)=>{writes.push({key,ttl});cache.set(key,{value,expiry:now+ttl*1000});}},
    gateway:{getScratchHistory:async query=>{queries.push(query);return {records:structuredClone(records)};}}}};
  return {ctx:{table,session,runtime,financialGameId:91061},row,cache,writes,queries,at:value=>{now=value;},records:value=>{records=value;}};
}

test('the same canonical request expires at three minutes and cache hits never extend its lifetime',async()=>{
  const f=fixture();assert.equal((await list(f.ctx)).winInfo[0].serialNo,'original');
  f.ctx.body={userId:999,roomId:123,extra:Math.random()};f.at(179999);
  await list(f.ctx);assert.equal(f.queries.length,1);assert.equal(f.writes.length,1);
  f.at(180000);await list(f.ctx);assert.equal(f.queries.length,2);assert.equal(f.writes.length,2);
  assert.equal(f.writes[0].key,f.writes[1].key);assert.equal(f.writes[0].ttl,180);
  assert.equal(f.queries[0].gameId,91061);assert.equal(f.queries[0].size,100);assert.equal(f.queries[0].roomId,f.ctx.table.roomId);
  assert.equal(f.queries[0].endTime-f.queries[0].startTime,31*86400000);
});

test('cache keys isolate player, agent, currency, room and room type',async()=>{
  const f=fixture();await list(f.ctx);
  for(const change of [
    ctx=>{ctx.session={...ctx.session,userId:43};},
    ctx=>{ctx.session={...ctx.session,agentId:8};ctx.table={...ctx.table,agentId:8};},
    ctx=>{ctx.session={...ctx.session,currency:'USD'};},
    ctx=>{ctx.table={...ctx.table,roomId:61010027};},
    ctx=>{ctx.table={...ctx.table,roomType:63};},
  ]){const ctx={...f.ctx,session:{...f.ctx.session},table:{...f.ctx.table}};change(ctx);await list(ctx);}
  assert.equal(f.queries.length,6);assert.equal(new Set(f.writes.map(w=>w.key)).size,6);
  await assert.rejects(()=>list({...f.ctx,session:{...f.ctx.session,agentId:99}}),/scope/);
});

test('ES errors are not cached, corrupt cache is replaced, Redis outages still query ES',async()=>{
  const f=fixture(),gateway=f.ctx.runtime.rpc.gateway,original=gateway.getScratchHistory;
  gateway.getScratchHistory=async()=>{throw Error('ES offline');};
  await assert.rejects(()=>list(f.ctx),/ES offline/);assert.equal(f.writes.length,0);assert.equal(f.ctx.runtime.scratchHistoryReads.pending.size,0);
  gateway.getScratchHistory=original;await list(f.ctx);
  const key=f.writes[0].key;f.cache.set(key,{value:'corrupt',expiry:999999});await list(f.ctx);assert.equal(f.queries.length,2);
  f.ctx.runtime.rpc.bus={getCache:async()=>{throw Error('Redis offline');},setCache:async()=>{throw Error('Redis offline');}};
  assert.equal((await list(f.ctx)).winInfo.length,1);assert.equal(f.queries.length,3);
});

test('parallel native requests share one ES read; records are masked to the actual account and chronological order',async()=>{
  const f=fixture();f.records([{...f.row,log:JSON.stringify({...JSON.parse(f.row.log),serialNo:'newer'})},f.row,f.row,
    {...f.row,userId:43},{...f.row,currency:'USD'},{...f.row,log:JSON.stringify({...JSON.parse(f.row.log),roomId:999})},{...f.row,gameId:91063}]);
  const results=await Promise.all(Array.from({length:20},()=>list(f.ctx)));
  assert.equal(f.queries.length,1);assert.equal(f.writes.length,1);
  assert.deepEqual(results[0].winInfo.map(r=>r.serialNo),['original','newer']);
});

test('production ticket adapter reads ES history without calling the lottery history or state RPC',async()=>{
  const f=fixture(),routes=createGameRouteIndex([{gameType:1004,roomType:61,number:91061,symbol:'test',state:1,isFrozen:0}]);
  const tickets=createRpcScratchTickets({scratch:()=>assert.fail('history must not invoke financial RPC')},{routes});
  const rows=await tickets.history(f.ctx);assert.equal(rows.length,1);assert.equal(f.queries.length,1);
});

test('native history uses log round details even if init disagrees and never substitutes init for missing log',async()=>{
  const f=fixture();
  f.records([{...f.row,init:JSON.stringify({...JSON.parse(f.row.log),serialNo:'wrong-init'})},
    {...f.row,log:'invalid',init:f.row.log}]);
  const result=await list(f.ctx);
  assert.deepEqual(result.winInfo.map(row=>row.serialNo),['original']);
});
