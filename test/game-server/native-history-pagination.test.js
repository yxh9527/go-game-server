import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {queryNativeHistory}=await importHotModule(new URL("../../game-server/src/core/game-history.js",import.meta.url).href,"history-selected-test/game-server/native-history-pagination.test.js");

function fixture(type=25){
  const requests=[],cache=new Map(),ttls=[],records=[];
  const table={agentId:7,roomId:700025,roomType:type,gameId:type===25?'zjh':'sgay',ante:9999,playMode:0,createdAt:Date.now()-86400000,roomRules:{}};
  const session={userId:42,agentId:7,currency:'CNY'};
  for(let inning=1;inning<=230;inning++)records.push({id:'original-'+inning,userId:42,agentId:7,currency:'CNY',roomType:type,roomId:table.roomId,inning,endedAt:table.createdAt+inning*1000,playMode:0,room:{ante:50},
    detail:{nativeHistory:{ante:50,config:{roomType:type===25?'ctjh':'sgya'},events:[],row:{gameRoomId:table.roomId,currentInningNum:inning,firstGameList:[{uid:42,handPais:[0,1,2],showCards:[0,1,2]}],excellentGame:inning<=120&&inning%2===0}}}});
  const runtime={env:'prod',gateway:{getUserCenter:async query=>{
    requests.push(query);
    let rows=records.filter(r=>r.userId===query.userId&&r.agentId===query.agentId&&r.currency===query.currency&&r.roomId===query.roomId&&r.roomType===query.roomType
      &&(!query.inning||r.inning===query.inning)&&(!query.inningFrom||r.inning>=query.inningFrom)&&(!query.inningTo||r.inning<=query.inningTo));
    rows=rows.toSorted((a,b)=>query.sortDesc?b.inning-a.inning:a.inning-b.inning);
    return {records:structuredClone(query.kind==='room'?rows:rows.slice((query.page-1)*query.size,query.page*query.size)),paged:true,total:rows.length};
  }},bus:{getCache:async key=>cache.get(key),setCache:async(key,raw,ttl)=>{cache.set(key,raw);ttls.push(ttl);}}};
  return {ctx:{table,session,runtime},requests,records,cache,ttls};
}

test('Jinhua historical range outside the latest page returns its first twenty original innings',async()=>{
  const f=fixture();
  const result=await queryNativeHistory(f.ctx,{beginNum:0,endNum:49});
  assert.deepEqual(result.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>i+1));
  assert.equal(result.totalNum,230);assert.equal(result.beginNum,1);assert.equal(result.endNum,20);assert.equal(result.ante,50);
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].inningFrom,1);assert.equal(f.requests[1].inningTo,50);
  assert.equal(f.requests[1].sortDesc,false);assert.equal(f.requests[1].size,20);
  const calls=f.requests.length;await queryNativeHistory(f.ctx,{beginNum:0,endNum:49});assert.equal(f.requests.length,calls);
  assert.ok(f.ttls.every(ttl=>ttl===180));
});

test('Jinhua range within the latest hundred also selects the first twenty and preserves default newest-page order',async()=>{
  const f=fixture();
  const range=await queryNativeHistory(f.ctx,{beginNum:149,endNum:199});
  assert.deepEqual(range.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>i+150));
  assert.equal(f.requests.length,1);assert.equal(range.totalNum,230);
  const newest=await queryNativeHistory(f.ctx,{});
  assert.deepEqual(newest.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>i+211));
});

test('Jinhua excellent 0/0 request reads original room records outside the latest hundred without narrowing to inning one',async()=>{
  const f=fixture(),before=structuredClone(f.records);
  const result=await queryNativeHistory(f.ctx,{excellentGame:true,beginNum:0,endNum:0});
  assert.deepEqual(result.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>82+i*2));
  assert.equal(result.totalNum,230);assert.equal(result.excellentGame,true);assert.equal(result.ante,50);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].kind,'room');assert.equal(f.requests[0].inning,0);assert.equal(f.requests[0].inningTo,0);
  assert.equal(f.requests[0].userId,42);assert.equal(f.requests[0].agentId,7);assert.equal(f.requests[0].currency,'CNY');assert.equal(f.requests[0].roomId,700025);
  await queryNativeHistory(f.ctx,{excellentGame:true,beginNum:0,endNum:0});assert.equal(f.requests.length,1);
  await queryNativeHistory(f.ctx,{beginNum:0,endNum:0});assert.equal(f.requests.length,3,'normal first inning must use different result caches');
  assert.deepEqual(f.records,before,'query cannot rewrite original settlement details');
});

test('Jinhua explicit excellent range and exact inning retain their own original semantics',async()=>{
  const f=fixture();
  const range=await queryNativeHistory(f.ctx,{excellentGame:true,beginNum:0,endNum:49});
  assert.deepEqual(range.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>2+i*2));
  const exact=await queryNativeHistory(f.ctx,{excellentGame:true,inningNum:10,beginNum:0,endNum:0});
  assert.deepEqual(exact.playBackList.map(row=>row.currentInningNum),[10]);assert.equal(exact.totalNum,230);
  const notExcellent=await queryNativeHistory(f.ctx,{excellentGame:true,inningNum:11});assert.deepEqual(notExcellent.playBackList,[]);
});

test('an upper-bound-only old range queries its actual original interval rather than the latest page',async()=>{
  const f=fixture();
  const result=await queryNativeHistory(f.ctx,{endNum:49});
  assert.deepEqual(result.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>i+1));
  assert.equal(result.totalNum,230);assert.equal(f.requests.length,2);assert.equal(f.requests[1].inningFrom,0);assert.equal(f.requests[1].inningTo,50);
});

test('empty excellent history stays empty instead of falling back to non-excellent results or another account',async()=>{
  const f=fixture();for(const row of f.records)row.detail.nativeHistory.row.excellentGame=false;
  f.records.push({...f.records[0],userId:43,inning:1,detail:{nativeHistory:{row:{currentInningNum:1,excellentGame:true}}}});
  const result=await queryNativeHistory(f.ctx,{excellentGame:true,beginNum:0,endNum:0});assert.deepEqual(result.playBackList,[]);assert.equal(result.totalNum,230);
});

for(const type of [26,28,30,32])test('type '+type+' preserves its original latest-twenty range convention',async()=>{
  const f=fixture(type);for(const row of f.records)row.detail.nativeHistory.row.excellentGame=false;
  const result=await queryNativeHistory(f.ctx,{beginNum:0,endNum:49});
  assert.deepEqual(result.playBackList.map(row=>row.currentInningNum),Array.from({length:20},(_,i)=>i+31));
  assert.equal(result.totalNum,230);assert.equal(result.ante,50);
});
