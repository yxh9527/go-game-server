import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {captureHoldemReplay,queryHoldemReplay}=await importHotModule(new URL("../../shared/holdem-replay-store.js",import.meta.url).href,"history-selected-test/shared/holdem-replay-store.test.js");

test('persisted replay masks opponents in cards and events, preserves ordered actions, and scopes cached queries',async()=>{
 const table={roomId:999,currentInning:5,smallBlind:5,bigBlind:10,members:[{uid:1,name:'owner',hole:[1,2],pos:0},{uid:2,name:'opponent',hole:[3,4],pos:1}]};
 const hand={participants:table.members,board:[10,11,12,13,14],pot:40,replayActions:[{uid:2,replayOrder:1,gameState:4,operationType:7,bet:20,cards:[3,4]}],
  replayEvents:[{uid:2,replayOrder:1,gameState:4,operationType:7,cards:[3,4,10,11,12]},{uid:0,replayOrder:2,gameState:5,board:[10,11,12]}]};
 const replay=captureHoldemReplay(table,hand,[{uid:1,score:20,isWin:true,showCards:[1,2]},{uid:2,score:-20,showCards:[]}],1);
 assert.deepEqual(replay.firstGameList[1].cards,[-1,-1,10,11,12,13,14]);assert.equal(replay.firstGameList[1].operateList[0].cards,undefined);assert.equal(replay.roundEvents[0].cards,undefined);
 const record={userId:1,agentId:7,currency:'CNY',roomType:19,roomId:999,inning:5,room:{smallBlind:5,bigBlind:10},detail:{replay}};
 let reads=0;const cache=new Map(),runtime={gateway:{getUserCenter:async query=>{reads++;assert.equal(query.agentId,7);assert.equal(query.userId,1);return {records:[record,{...record,userId:2}]}}},bus:{getCache:async k=>cache.get(k),setCache:async(k,v)=>cache.set(k,v)}};
 const account={userId:1,agentId:7,currency:'CNY'},req={roomId:999,inningNum:5};
 const detail=await queryHoldemReplay(runtime,account,req,true);
 const players=JSON.parse(detail.exploitsInfoMsgs[0].inningResults);assert.deepEqual(players.find(p=>p.uid===2).showCards,[-1,-1]);assert.deepEqual(players.find(p=>p.uid===1).showCards,[1,2]);
 await queryHoldemReplay(runtime,account,req,true);assert.equal(reads,1);
 const list=await queryHoldemReplay(runtime,account,{roomId:999,beginNum:4,endNum:4});assert.equal(list.playBackList.length,1);assert.equal(list.playBackList[0].currentInningNum,5);
 await assert.rejects(()=>queryHoldemReplay(runtime,{userId:1,agentId:0},req,true),/无效/);
});
