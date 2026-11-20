import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
import {loadGames} from '../../game-server/src/games/catalog.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
const {queryNativeHistory,queryHundredHistory}=await importHotModule(new URL("../../game-server/src/core/game-history.js",import.meta.url).href,"history-selected-test/game-server/production-history.test.js");
const {queryGameHistoryDetail}=await importHotModule(new URL("../../shared/game-history-detail.js",import.meta.url).href,"history-selected-test/game-server/production-history.test.js");
const {queryHoldemReplay}=await importHotModule(new URL("../../shared/holdem-replay-store.js",import.meta.url).href,"history-selected-test/game-server/production-history.test.js");
import {SEND as COMMON_SEND} from '../../game-server/src/messages.js';
import {PROTOCOL as MAHJONG} from '../../game-server/src/games/mahjong/messages.js';
import {SEND as NN} from '../../game-server/src/games/niuniu/messages.js';
import {SEND as SSS} from '../../game-server/src/games/sss/messages.js';
import {SEND as BJ} from '../../game-server/src/games/blackjack/messages.js';
import {SEND as SG} from '../../game-server/src/games/sgay/messages.js';
import {ZJH_SEND} from '../../game-server/src/games/zjh/messages.js';

const games=await loadGames('production-history'),configs=seedRooms();
function fixture(game,roomType){
  const cfg=configs.find(r=>Number(r.room_type)===roomType)||{room_type:roomType};
  const table=game.createTable(700000+roomType,roomType,cfg);table.agentId=7;table.currentInning=3;table.inning=3;
  table.smallBlind||=5;table.bigBlind||=10;
  const session={userId:42,agentId:7,currency:'CNY',name:'original-user',wallet:1000};
  const members=[42,43].map((uid,pos)=>({uid,pos,name:'p'+uid,icon:'1',point:1000,openingPoint:1000,totalBet:100,hole:roomType===25?[0,1,2]:[0,1],state:1}));
  table.members=members;
  const results=members.map((p,i)=>({uid:p.uid,pos:p.pos,score:i?-100:100,xiaZhuData:100,handPais:p.hole.slice(),showCards:i?[]:p.hole.slice(),
    handCards:[0,1],groupCards:[],handResults:[{handCards:[0,1],xiaZhuData:100,score:i?-100:100}],userName:p.name}));
  const registry=createRegistry(),persisted=[];
  const runtime={env:'prod',registry,wallet:{stageFinalReports:(_table,records)=>{persisted.push(...structuredClone(records));}},gateway:{getUserCenter:async query=>({records:structuredClone(persisted.filter(r=>r.userId===query.userId&&r.agentId===query.agentId&&r.currency===query.currency&&(!query.roomType||r.roomType===query.roomType)&&(!query.roomId||r.roomId===query.roomId)&&(!query.inning||r.inning===query.inning)))}),writeUserCenter:async rows=>({stored:rows.length,durable:true})},log:{error:message=>assert.fail(message)}};
  installUserCenter(runtime);registry.bind({},session);registry.setTable(table.roomId,table,7,game.id);
  table.hand={participants:members,statsPlayers:members,players:members,board:[5,6,7],pot:200,rules:table.roomRules,
    events:[{uid:42,operationType:1,bet:100}],bankerPos:0,comparison:{compareResults:[],scoreMap:{42:100,43:-100}},
    actionList:[{banker:true,handResults:[{handCards:[3,4],score:0}]}],replayActions:[],replayEvents:[]};
  const publicResult=game.id==='mahjong'?{resultList:results.map(r=>({...r,name:r.userName,flowerFan:0,gangFan:0})),winUid:42,bankerPos:0}:undefined;
  const messages=[];const ctx={table,session,runtime,send:(id,payload)=>messages.push({id,payload}),io:{}};
  return {table,session,runtime,registry,results,publicResult,persisted,messages,ctx};
}

const historyRequest={24:NN.HISTORY,25:ZJH_SEND.GAME_BACK,27:SSS.HISTORY,31:BJ.HISTORY,32:SG.HISTORY,26:MAHJONG.jsmj.history,28:MAHJONG.csmj.history,30:MAHJONG.hzxl.history};
for(const game of games.list.filter(g=>g.kind==='normal'&&g.id!=='holdem'))for(const roomType of game.roomTypes)test('production '+game.id+' '+roomType+' captures original native history in the final report and serves it after hand removal',async()=>{
  const f=fixture(game,roomType);f.table.recordUserCenter(f.results,{publicResult:f.publicResult});await f.runtime.userCenterState.writeTask;
  assert.equal(f.persisted.length,2);assert.ok(f.persisted.every(r=>r.detail.nativeHistory?.row&&r.detail.nativeHistory?.events));
  f.table.hand=null;f.table.history=[];f.table.mahjongHistory=[];f.table.members=[];
  assert.equal(await game.onMessage(f.ctx,historyRequest[roomType],{}),true);
  const payload=f.messages.at(-1).payload;
  if(roomType===24||roomType===27)assert.equal(payload.dataInfo.currentInningNum,3);
  else if(roomType===31){assert.equal(payload.currentInning,3);assert.equal(payload.gameBackInfo.inningInfo[0][0].banker,true);assert.deepEqual(payload.gameBackInfo.inningInfo[0][0].handResults[0].handCards,[3,4]);}
  else assert.equal(payload.playBackList[0].currentInningNum,3);
  if(roomType===24)for(const player of payload.dataInfo.firstGameList){
    assert.equal(player.seeCardNo,payload.dataInfo.seeCardNo);assert.equal(player.posType,player.banker?1:0);assert.deepEqual(player.cardTypePokers,player.handPais);
  }
  const http=await queryGameHistoryDetail(f.runtime,f.session,{gameRoomId:f.table.roomId,inningNum:3,roomType});
  assert.ok(http.exploitsInfoMsgs[0].roundList);assert.equal(JSON.parse(http.exploitsInfoMsgs[0].inningResults).length,roomType===31?3:2);
  assert.equal(http.exploitsInfoMsgs[0].memberResults.length,2);
  await assert.rejects(()=>queryNativeHistory({...f.ctx,session:{...f.session,agentId:8}}),/账户/);
  await assert.rejects(()=>queryNativeHistory(f.ctx,{inningNum:1.5}),/范围/);
});

for(const game of games.list.filter(g=>g.kind==='hundred'))test('production '+game.id+' reviews use the common original settlement query without a room-local history copy',async()=>{
  const roomType=game.roomTypes[0],f=fixture(game,roomType);
  const detail={gameRoomId:f.table.roomId,currInning:3,showdownPokers:{other:[1,2],banker:[3,4]},showdownTypes:{other:5,banker:9},winAreaIds:[1],betDetailTableMap:{1:{betScore:100,realScore:100}}};
  f.persisted.push({userId:42,agentId:7,currency:'CNY',gameId:game.id,roomType,roomId:f.table.roomId,inning:3,detail});
  await game.onMessage(f.ctx,COMMON_SEND.REQUEST_100_RECORD,{});assert.deepEqual(f.messages.at(-1).payload.list,[3]);
  await game.onMessage(f.ctx,COMMON_SEND.REQUEST_ONE_RECORD,{currInning:3});assert.equal(f.messages.at(-1).payload.currInning,3);
  assert.equal(await queryHundredHistory({...f.ctx,session:{...f.session,userId:99}},3),null);
  assert.equal(f.table.hundredHistory,undefined);
});

test('production holdem replay preserves own holes and masks folded opponent cards after original report persistence',async()=>{
  const f=fixture(games.byRoomType.get(19),19);
  f.table.recordUserCenter(f.results);await f.runtime.userCenterState.writeTask;f.table.hand=null;
  const payload=await queryHoldemReplay(f.runtime,f.session,{roomId:f.table.roomId,roomType:19,beginNum:-1,endNum:-1});
  const players=payload.playBackList[0].firstGameList;
  assert.deepEqual(players.find(p=>p.uid===42).handPais,[0,1]);assert.ok(players.find(p=>p.uid===43).handPais.every(card=>card===-1));
  assert.deepEqual(f.persisted.find(r=>r.userId===42).detail.replay.firstGameList.find(p=>p.uid===43).handPais,[-1,-1]);
});

test('a native request for an older inning fetches its own ES range and preserves the latest inning header',async()=>{
  const game=games.byRoomType.get(24),f=fixture(game,24),queries=[];
  f.table.recordUserCenter(f.results);await f.runtime.userCenterState.writeTask;
  const original=f.persisted.find(r=>r.userId===42),old={...original,inning:1,detail:{...original.detail,nativeHistory:{...original.detail.nativeHistory,row:{...original.detail.nativeHistory.row,currentInningNum:1}}}};
  f.runtime.gateway.getUserCenter=async q=>{queries.push(q);return {records:[q.inning===1?old:original]};};
  f.table.hand=null;
  const result=await queryNativeHistory(f.ctx,{inningNum:1});assert.equal(result.dataInfo.currentInningNum,1);assert.equal(result.totalNum,3);
  assert.equal(queries.length,2);assert.equal(queries[1].inning,1);
});

for(const game of games.list.filter(game=>game.kind==='hundred'))test('older '+game.id+' production detail reaches ES beyond the latest 100 rows and keeps account/room scope',async()=>{
  const f=fixture(game,game.roomTypes[0]),queries=[],cache=new Map(),ttls=[];
  const original={userId:42,agentId:7,currency:'CNY',roomType:f.table.roomType,roomId:f.table.roomId,inning:1,
    detail:{gameRoomId:f.table.roomId,currInning:1,showdownPokers:{other:[1,2],banker:[3,4]},showdownTypes:{other:5,banker:9},
      winAreaIds:[1],betDetailTableMap:{1:{betScore:100,realScore:100,score:200,tax:0,odds:1}}}};
  const recent=Array.from({length:100},(_,i)=>({...original,inning:102+i,detail:{...original.detail,currInning:102+i}})).reverse();
  f.runtime.gateway.getUserCenter=async query=>{queries.push(query);await new Promise(resolve=>setImmediate(resolve));return {records:structuredClone(query.inning===1?[original]:recent)};};
  f.runtime.bus={getCache:async key=>cache.get(key),setCache:async(key,value,ttl)=>{cache.set(key,value);ttls.push(ttl);}};
  const detail=await Promise.all(Array.from({length:20},()=>queryHundredHistory(f.ctx,1)));
  assert.equal(queries.length,2,'parallel reviews should share the latest and exact queries');
  assert.ok(detail.every(row=>row.currInning===1));assert.deepEqual(detail[0].betDetailTableMap,original.detail.betDetailTableMap);
  assert.equal(queries[1].inning,1);assert.equal(queries[1].roomType,f.table.roomType);assert.equal(queries[1].roomId,f.table.roomId);
  assert.equal(queries[1].userId,42);assert.equal(queries[1].agentId,7);assert.equal(queries[1].currency,'CNY');
  assert.deepEqual(ttls,[180,180]);
  const list=await queryHundredHistory(f.ctx);assert.equal(list.list.length,100);assert.equal(list.list[0],102);assert.equal(list.list.at(-1),201);
  await queryHundredHistory(f.ctx,1);assert.equal(queries.length,2,'detail must reuse its own fixed-lifetime query cache');
  await game.onMessage(f.ctx,COMMON_SEND.REQUEST_ONE_RECORD,{currInning:1});assert.equal(f.messages.at(-1).payload.currInning,1);
});

test('an empty cached latest page does not hide an original exact detail that ES can now return',async()=>{
  const f=fixture(games.byRoomType.get(58),58),queries=[],cache=new Map();
  const source={userId:42,agentId:7,currency:'CNY',roomType:58,roomId:f.table.roomId,inning:8,detail:{currInning:8,gameRoomId:f.table.roomId,winAreaIds:[1],betDetailTableMap:{}}};
  f.runtime.gateway.getUserCenter=async query=>{queries.push(query);return {records:query.inning===8?[source]:[]};};
  f.runtime.bus={getCache:async key=>cache.get(key),setCache:async(key,value)=>cache.set(key,value)};
  assert.deepEqual((await queryHundredHistory(f.ctx)).list,[]);
  const found=await queryHundredHistory(f.ctx,8);assert.equal(found.currInning,8);assert.equal(queries.length,2);assert.equal(queries[1].inning,8);
});

test('exact detail failures and unauthorized source rows never become a successful old-room review',async()=>{
  const f=fixture(games.byRoomType.get(53),53);let reads=0;
  f.runtime.gateway.getUserCenter=async query=>{reads++;if(query.inning)throw Error('original detail source offline');return {records:[]};};
  await assert.rejects(()=>queryHundredHistory(f.ctx,1),/source offline/);assert.equal(reads,2);
  f.runtime.gateway.getUserCenter=async query=>({records:query.inning?[{userId:99,agentId:7,currency:'CNY',roomType:53,roomId:f.table.roomId,inning:1,detail:{currInning:1}}]:[]});
  assert.equal(await queryHundredHistory(f.ctx,1),null);
  f.runtime.gateway.getUserCenter=()=>assert.fail('invalid inning must be rejected before cache or RPC');
  for(const inning of [-1,0,1.5,NaN,Infinity])assert.equal(await queryHundredHistory(f.ctx,inning),null);
});
