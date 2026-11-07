import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import {WebSocketServer} from 'ws';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createApp} from '../../hall/src/create-app.js';
import {createRegistry,findConfig} from '../../game-server/src/registry.js';
import {createWallet} from '../../game-server/src/wallet/index.js';
import {installUserCenter} from '../../game-server/src/core/user-center.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import scratch from '../../game-server/src/games/ggl-mjhl/index.js';
import {createScratchTickets} from '../../cache/game-server/scratch-tickets.js';
import {legacyUserCenterRecords} from '../../cache/game-server/user-center.js';

function nativeAPI(file,id,api){
 const root={webpackChunk_N_E:[]};vm.runInNewContext(fs.readFileSync(file,'utf8'),{self:root,window:root});
 const factories=root.webpackChunk_N_E.flatMap(row=>Object.entries(row[1]));let factory=factories.find(([key])=>Number(key)===id)?.[1];assert.ok(factory);
 if(id===6903)factory=vm.runInNewContext('('+factory.toString().replace('n.d(t,{A:()=>I});','n.d(t,{A:()=>I,testQuery:()=>i});')+')',{});
 const req=module=>module===6606?{N3:()=>({userId:101,clubId:7})}:module===8208?{j6:api,qd:()=>assert.fail('native request failed')}:{A:()=>null};
 req.d=(exports,items)=>{for(const [key,value]of Object.entries(items))Object.defineProperty(exports,key,{get:value});};req.n=value=>()=>value;
 const mod={exports:{}};factory(mod,mod.exports,req);return mod.exports;
}

test('real settled holdem hand appears through native battle and fund requests across hot reload',async t=>{
 const registry=createRegistry(),wallet=createWallet({mode:'local',local_balance:1000000});
 const gateway={authenticate:async(token,userId)=>({success:token==='valid',userId}),validateToken:async token=>token==='valid',getLoginData:async userId=>({userId,agentId:7,userName:'p'+userId,currency:{symbol:'CNY'}}),
  getUserCenter:()=>assert.fail('dev cannot query persistent history'),getRecords:()=>assert.fail('dev cannot query ES')};
 const configs=seedRooms().map(row=>({...row,robot_behavior:{joinProbability:0,leaveProbability:0}}));
 const runtime={env:'dev',hotVersion:'center-before',registry,wallet,gateway,configs,findConfig,log:{info(){},error(){}}};let handler=await createHandler(runtime);
 const peer=uid=>{const messages=[],ws={readyState:1,send:raw=>messages.push(decodeFrame(raw))};return {uid,ws,messages,send:(id,data)=>handler.onMessage(ws,encodeFrame(id,data))};};
 const peers=[peer(101),peer(102)];for(const p of peers){await p.send(1105,{userId:p.uid,userToken:'valid',roomId:700000});await p.send(2102,{roomId:700000,roomType:19});await p.send(5003,{position:p.uid-101});}
 const table=registry.getTable(700000,7,'holdem');for(const p of peers)await p.send(5001,{carryIn:table.carryMin/100});table.startAt=0;await handler.tick();assert.equal(table.phase,'playing');
 const actor=peers.find(p=>p.uid===table.hand.actorUid);await actor.send(3162,{operation:6,operationData:0});assert.equal(table.hand,null);
 const records=[...runtime.userCenterState.records.values()];assert.equal(records.length,2);const mine=records.find(r=>r.userId===101);assert.ok(Number.isSafeInteger(mine.net));assert.equal(mine.balance,registry.session(peers[0].ws).wallet);
 runtime.hotVersion='center-after';handler=await createHandler(runtime);
 const server=http.createServer(),wss=new WebSocketServer({server});wss.on('connection',ws=>{ws.on('message',raw=>void handler.onMessage(ws,raw));ws.on('close',()=>void handler.onClose(ws));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{wss.close();server.close(resolve);}));
 const hall=await createApp({env:'dev',hotVersion:'center-http',gateway,config:{game_server:'127.0.0.1:'+server.address().port},log:{error(){}},matchStore:{listMatches:()=>[]},roomStore:{list:()=>configs}});
 const web=http.createServer(hall);await new Promise(resolve=>web.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>web.close(resolve)));
 const api=async params=>{const fields=new URLSearchParams({...params,userId:'101',token:'valid'}),param=Buffer.from(fields.toString()).toString('base64');const response=await fetch('http://127.0.0.1:'+web.address().port+'/internal/v1/do?param='+encodeURIComponent(param));assert.equal(response.headers.get('cache-control'),'no-store');return response.json();};
 const profile=await api({op:8165,uid:101});assert.equal(profile.msgCode,200);assert.equal(profile.data.name,'p101');
 assert.match(profile.data.imageUrl,/^\/avator\/\d+\.png$/);assert.equal((await fetch('http://127.0.0.1:'+web.address().port+profile.data.imageUrl)).status,200);
 const battle=nativeAPI('static/hall/_next/static/chunks/832-7498b6b2aa7730de.js',1474,api);
 const list=await battle.im(27,{roomType:19,pageNum:1,startDateDiff:0,endDateDiff:0});assert.equal(list.totalSize,1);assert.equal(list.infoList[0].currentScore,mine.net);assert.equal(list.infoList[0].gameRoomId,table.roomId);
 const empty=await battle.im(51,{roomType:58,pageNum:1,startDateDiff:0,endDateDiff:0});assert.equal(empty.totalSize,0);assert.equal(empty.infoList.length,0);
 const hands=await battle.QZ({gameRoomId:table.roomId,pageNum:1,showMe:true,sortRule:'create_time asc'});assert.equal(hands.totalInning,1);assert.ok(Array.isArray(hands.infoList[0].firstGameList));
 const row=hands.infoList[0],replay=table.history[0],own=replay.firstGameList.find(p=>p.uid===101),opponent=row.firstGameList.find(p=>p.uid===102);
 assert.deepEqual(row.ownCards,own.cards.slice(0,2),'native hand card component reads top-level ownCards');
 assert.deepEqual(row.commonCards,own.commonPoker,'never manufacture undealt community cards');
 assert.deepEqual(row.firstGameList.find(p=>p.uid===101).operateList.find(a=>a.gameState===3).cards,row.ownCards);
 assert.deepEqual(opponent.handPais,opponent.showCards.length?opponent.showCards:[-1,-1]);
 assert.ok(opponent.operateList.every(a=>!a.cards||a.gameState===3||[5,7,9].includes(a.gameState)),'bet actions cannot contain private holes');
 const funds=nativeAPI('static/hall/_next/static/chunks/903-32a74abc84f530c1.js',6903,api);
 const logs=await funds.testQuery(39,{uid:101,clubId:7,pageNum:1,startTime:String(Date.now()-86400000),endTime:String(Date.now()+1000)});assert.equal(logs.count,1);assert.equal(logs.logs[0].point,mine.net);assert.equal(logs.logs[0].lastPoint,mine.balance);
 assert.equal(registry.sessions.size,2,'read-only query sockets never bind or kick the active player');
 const spoof=await api({op:39,uid:102});assert.equal(spoof.msgCode,403);
});

test('hot reload hydrates older display records from real replay without changing balance or time',()=>{
 const registry=createRegistry(),runtime={env:'dev',registry,wallet:{},log:{error(){}}};
 const center=installUserCenter(runtime,legacyUserCenterRecords);
 const table={gameId:'holdem',roomType:19,roomId:19,agentId:7,history:[]};registry.setTable(19,table,7,'holdem');
 const base={id:'existing',userId:42,agentId:7,currency:'CNY',gameId:'holdem',roomType:19,roomId:19,inning:1,endedAt:1800000000000,net:-10,balance:990,detail:{firstGameList:[]}};
 runtime.userCenterState.records.set(base.id,base);
 table.history.push({currentInningNum:1,firstGameList:[
   {uid:42,score:-10,cards:[0,12,5,6,7],handPais:[0,12],showCards:[-1,-1],commonPoker:[5,6,7],operateList:[{gameState:4,operate:6,cards:[0,12,5,6,7]}]},
   {uid:43,score:10,cards:[30,31,5,6,7],handPais:[30,31],showCards:[-1,31],commonPoker:[5,6,7],operateList:[{gameState:4,operate:7,cards:[30,31,5,6,7]}]}
 ]});
 const result=center.query({userId:42,agentId:7,currency:'CNY'}).records[0];
 assert.equal(result.endedAt,base.endedAt);assert.equal(result.balance,990);assert.equal(runtime.userCenterState.records.get(base.id),base);
 assert.deepEqual(result.detail.ownCards,[0,12]);assert.deepEqual(result.detail.commonCards,[5,6,7]);assert.deepEqual(result.detail.winCards,[-1,31]);
 const opponent=result.detail.firstGameList.find(p=>p.uid===43);assert.deepEqual(opponent.handPais,[-1,31]);assert.equal(opponent.operateList[0].cards,undefined);
 table.history.push({currentInningNum:2,firstGameList:[{uid:42,score:10,cards:[1,2],commonPoker:[]}]});
 assert.equal(center.query({userId:42,agentId:7,currency:'CNY'}).records.length,1,'undated old history must not receive a fabricated settlement time');
});

test('display projections follow commit and never expose opponent account balances',()=>{
 const registry=createRegistry(),deliveries=[],runtime={env:'dev',registry,wallet:{deliver:fn=>deliveries.push(fn)},log:{error(){}}};const center=installUserCenter(runtime);
 const table={gameId:'hundred-holdem',roomType:50,roomId:1,agentId:7,kind:'hundred',inning:1,members:[],playerSessions:new Map([[42,{userId:42,agentId:7,wallet:1111}],[43,{userId:43,agentId:7,wallet:2222}]])};registry.setTable(1,table,7,table.gameId);
 table.recordUserCenter([{uid:42,score:10,xiaZhuData:100,walletAmount:1111},{uid:43,score:-10,xiaZhuData:100,walletAmount:2222}]);assert.equal(runtime.userCenterState.records.size,0);deliveries.shift()();
 const record=center.query({userId:42,agentId:7}).records[0];assert.equal(record.balance,1111);assert.equal(record.detail.firstGameList.find(p=>p.uid===43).walletAmount,undefined);
});

test('new golden-flower settlements retain all three summary cards and mask an unrevealed winner',()=>{
 const runtime={env:'dev',registry:createRegistry(),wallet:{},log:{error(){}}};
 const center=installUserCenter(runtime);
 const table={gameId:'zjh',roomType:25,roomId:25010000,agentId:7,kind:'normal',currentInning:1,
   hand:{statsPlayers:[{uid:42,hole:[0,11,35]},{uid:43,hole:[9,10,23]}]}};
 runtime.registry.setTable(table.roomId,table,7,table.gameId);
 table.recordUserCenter([{uid:42,score:-10,xiaZhuData:10,showCards:[-1,-1,-1]},
   {uid:43,score:10,xiaZhuData:10,isWin:true,showCards:[-1,-1,23]}]);
 const detail=center.query({userId:42,agentId:7}).records[0].detail;
 assert.deepEqual(detail.ownCards,[0,11,35]);assert.deepEqual(detail.winCards,[-1,-1,23]);assert.equal(detail.winScore,10);
});

test('re-reading a scratch result cannot move the original history time or balance',t=>{
 let clock=1800000000000;t.mock.method(Date,'now',()=>clock);const runtime={env:'dev',registry:createRegistry(),wallet:{},log:{error(){}}};installUserCenter(runtime);
 const table={gameId:'ggl-mjhl',roomType:61,roomId:1,agentId:7,kind:'slots',members:[]};runtime.registry.setTable(1,table,7,table.gameId);
 table.recordUserCenter([{uid:42,score:50,xiaZhuData:100,walletAmount:1050}],{key:'ticket-one',publicResult:{serialFull:'ticket-one'}});clock+=60000;
 table.recordUserCenter([{uid:42,score:50,xiaZhuData:100,walletAmount:2000}],{key:'ticket-one',publicResult:{serialFull:'ticket-one'}});
 assert.equal(runtime.userCenterState.records.size,1);const record=[...runtime.userCenterState.records.values()][0];assert.equal(record.endedAt,1800000000000);assert.equal(record.balance,1050);
});

test('actual in-memory scratch settlement publishes the native winInfo and no duplicate fund change',async()=>{
 const wallet=createWallet({mode:'local',local_balance:1000}),session={userId:42,agentId:7,currency:'CNY'};await wallet.load(session);
 const runtime={env:'dev',registry:createRegistry(),wallet,scratchTickets:createScratchTickets({draw:()=>Array(20).fill(8)}),log:{error(){}}};installUserCenter(runtime);
 const table=scratch.createTable(61010000,61,{});runtime.registry.setTable(table.roomId,table,7,scratch.id);let response;
 const ctx={runtime,table,session,send:(_id,data)=>{response=data;}};
 await scratch.onMessage(ctx,3701,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100});assert.equal(response.code,0);
 const serial=response.serialFull,record=[...runtime.userCenterState.records.values()][0];assert.equal(record.net,-100);assert.equal(record.balance,900);assert.equal(record.detail.winInfo.serialNo,serial);assert.equal(record.detail.winInfo.amount,-100);
 wallet.credit(session,100);await scratch.onMessage(ctx,3701,{revealMode:'SPECIFIED',serialFull:serial,faceValue:-999});assert.equal(response.code,0);
 assert.equal(runtime.userCenterState.records.size,1);assert.equal(record.balance,900);assert.equal(session.wallet,1000);
});
