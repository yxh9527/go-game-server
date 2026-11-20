import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {queryHoldemReplay}=await importHotModule(new URL("../../shared/holdem-replay-store.js",import.meta.url).href,"history-selected-test/shared/holdem-replay-pagination.test.js");

function fixture(roomType=19){
  const requests=[],cache=new Map(),ttls=[],account={userId:42,agentId:7,currency:'CNY'},roomId=700019,created=Date.now()-86400000;
  const records=Array.from({length:230},(_,i)=>{
    const inning=i+1,excellent=inning<=120&&inning%2===0;
    return {...account,id:'original-'+inning,roomId,roomType,inning,endedAt:created+inning*1000,room:{smallBlind:999,bigBlind:999,initialBet:999},
      detail:{replay:{gameRoomId:roomId,currentInningNum:inning,innerEndTime:created+inning*1000,smallBlind:5,bigBlind:10,initialBet:0,playMode:0,pot:200,
        firstGameList:[{uid:42,userName:'owner',showCards:[0,1],handPais:[0,1],commonPoker:[5,6,7],score:100,operateList:[{operate:excellent?9:7,gameState:4,bet:100}]},
          {uid:43,userName:'opponent',showCards:[-1,-1],handPais:[-1,-1],commonPoker:[5,6,7],score:-100,operateList:[]}],secondGameList:[],roundEvents:[]}}};
  });
  const runtime={gateway:{getUserCenter:async query=>{
    requests.push(query);await new Promise(resolve=>setImmediate(resolve));
    let rows=records.filter(r=>r.userId===query.userId&&r.agentId===query.agentId&&r.currency===query.currency&&r.roomId===query.roomId&&(!query.roomType||r.roomType===query.roomType)
      &&(!query.inning||r.inning===query.inning)&&(!query.inningFrom||r.inning>=query.inningFrom)&&(!query.inningTo||r.inning<=query.inningTo));
    rows=rows.toSorted((a,b)=>query.sortDesc?b.inning-a.inning:a.inning-b.inning);
    return {records:structuredClone(query.allInnings?rows:rows.slice((query.page-1)*query.size,query.page*query.size)),total:rows.length,paged:true};
  }},bus:{getCache:async key=>cache.get(key),setCache:async(key,value,ttl)=>{cache.set(key,value);ttls.push(ttl);}}};
  return {runtime,account,roomId,created,requests,records,cache,ttls};
}

for(const roomType of [19,101]){
  test('type '+roomType+' excellent 0/0 includes original all-in rounds before the latest hundred and never narrows to inning one',async()=>{
    const f=fixture(roomType),request={roomId:f.roomId,roomType,roomCreatedAt:f.created,beginNum:0,endNum:0,excellentGame:true};
    const result=await queryHoldemReplay(f.runtime,f.account,request);
    assert.deepEqual(result.playBackList.map(r=>r.currentInningNum),Array.from({length:60},(_,i)=>(i+1)*2));
    assert.equal(result.totalNum,120);assert.equal(f.requests.length,1);assert.equal(f.requests[0].allInnings,true);assert.equal(f.requests[0].inningFrom,0);assert.equal(f.requests[0].inningTo,0);
    await queryHoldemReplay(f.runtime,f.account,request);assert.equal(f.requests.length,1);assert.deepEqual(f.ttls,[180]);
  });
  test('type '+roomType+' older range returns the first twenty with its latest total header and original zero ante',async()=>{
    const f=fixture(roomType),result=await queryHoldemReplay(f.runtime,f.account,{roomId:f.roomId,roomType,roomCreatedAt:f.created,beginNum:0,endNum:49});
    assert.deepEqual(result.playBackList.map(r=>r.currentInningNum),Array.from({length:20},(_,i)=>i+1));
    assert.equal(result.totalNum,230);assert.equal(result.smallBlind,5);assert.equal(result.bigBlind,10);assert.equal(result.initialBet,0);
    assert.equal(f.requests.length,2);assert.equal(f.requests[1].sortDesc,false);assert.equal(f.requests[1].size,20);assert.equal(f.requests[1].inningFrom,1);assert.equal(f.requests[1].inningTo,50);
    assert.ok(result.playBackList.every(r=>r.firstGameList.find(p=>p.uid===43).cards.slice(0,2).every(card=>card===-1)));
  });
}

test('different parallel ranges share the latest source but never share a formatted result',async()=>{
  const f=fixture(),base={roomId:f.roomId,roomType:19,roomCreatedAt:f.created};
  const [first,second]=await Promise.all([
    queryHoldemReplay(f.runtime,f.account,{...base,beginNum:0,endNum:19}),queryHoldemReplay(f.runtime,f.account,{...base,beginNum:49,endNum:69})]);
  assert.equal(first.playBackList[0].currentInningNum,1);assert.equal(second.playBackList[0].currentInningNum,50);
  assert.equal(first.totalNum,230);assert.equal(second.totalNum,230);assert.equal(f.requests.length,3);
  assert.equal(f.runtime.holdemReplayReads.pending.size,0);assert.equal(f.runtime.historyQueries.pending.size,0);
});

test('excellent bounded and latest requests filter before slicing; ordinary default latest stays the newest twenty',async()=>{
  const f=fixture(),base={roomId:f.roomId,roomType:19,roomCreatedAt:f.created};
  const ranged=await queryHoldemReplay(f.runtime,f.account,{...base,excellentGame:true,beginNum:0,endNum:49});
  assert.deepEqual(ranged.playBackList.map(r=>r.currentInningNum),Array.from({length:20},(_,i)=>(i+1)*2));
  const newestExcellent=await queryHoldemReplay(f.runtime,f.account,{...base,excellentGame:true,beginNum:-1,endNum:-1});
  assert.deepEqual(newestExcellent.playBackList.map(r=>r.currentInningNum),Array.from({length:20},(_,i)=>82+i*2));
  assert.equal(f.requests.length,1,'both formats share one original full-room result');
  const newest=await queryHoldemReplay(f.runtime,f.account,base);
  assert.deepEqual(newest.playBackList.map(r=>r.currentInningNum),Array.from({length:20},(_,i)=>211+i));assert.equal(newest.totalNum,230);
});

test('replay source cannot substitute another owner, room or mismatching inner inning and errors release pending state',async()=>{
  const f=fixture(),request={roomId:f.roomId,roomType:19,inningNum:1};
  const original=f.runtime.gateway.getUserCenter;
  f.runtime.gateway.getUserCenter=async q=>{const value=await original(q);const row=value.records[0];return {records:[
    {...row,userId:99},{...row,roomId:999},{...row,detail:{replay:{...row.detail.replay,gameRoomId:999}}},
    {...row,detail:{replay:{...row.detail.replay,currentInningNum:2}}}]};};
  assert.equal(await queryHoldemReplay(f.runtime,f.account,request,true),null);
  f.runtime.gateway.getUserCenter=async()=>{throw Error('source offline');};
  await assert.rejects(()=>queryHoldemReplay(f.runtime,f.account,{...request,inningNum:3},true),/source offline/);
  assert.equal(f.runtime.holdemReplayReads.pending.size,0);
  const count=f.requests.length;
  await assert.rejects(()=>queryHoldemReplay(f.runtime,f.account,{...request,beginNum:20,endNum:1}),error=>error.status===400);assert.equal(f.requests.length,count);
});
