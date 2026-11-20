import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {userCenterQuery,userCenterResponse,userCenterProfileResponse}=await importHotModule(new URL('../../hall/src/user-center.js',import.meta.url).href,'hall-user-center-regression');
const {projectUserCenter}=await importHotModule(new URL('../../shared/user-center.js',import.meta.url).href,'player-service-regression');
const {userCenterMatch}=await importHotModule(new URL('../../shared/user-center-matches.js',import.meta.url).href,'player-service-regression');
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

const now=Date.UTC(2026,10,7,12),record=(extra={})=>({id:'one',userId:42,agentId:7,currency:'CNY',gameId:'holdem',roomType:19,roomId:700000,inning:1,endedAt:now-1000,
 effectiveBet:100,net:50,balance:1050,players:[{uid:42,score:50,userInfo:{name:'me'}}],detail:{firstGameList:[{uid:42,score:50,handPais:[1,2]}]},...extra});
const query=(extra={})=>({userId:42,agentId:7,currency:'CNY',kind:'battles',roomType:19,page:1,size:10,startTime:now-86400000,endTime:now,sortDesc:true,...extra});
test('user-center date filters use China time and bounded pagination',()=>{
 const q=userCenterQuery(39,{startTime:'2026-11-07 00:00:00',endTime:'2026-11-07 23:59:59',pageNum:'2',pageSize:'15'},now);
 assert.equal(q.startTime,Date.UTC(2026,10,6,16));assert.equal(q.endTime,Date.UTC(2026,10,7,15,59,59));assert.equal(q.page,2);
 for(const params of [{pageNum:-1},{pageSize:1000},{pageNum:1000,pageSize:100},{startTime:'2026-02-30 00:00:00'},{startDateDiff:99}])assert.throws(()=>userCenterQuery(27,params,now));
 const hand=userCenterQuery(28,{gameRoomId:700000,sortRule:'create_time asc'},now);assert.equal(hand.kind,'hands');assert.equal(hand.sortDesc,false);assert.ok(now-hand.startTime>=30*86400000);
});
test('normal battle groups, totals and hand pagination match native envelopes',()=>{
 const records=[record(),record({id:'two',inning:2,net:-10,endedAt:now-500}),record({id:'other-room',roomId:700001,net:20,endedAt:now-100})];
 const result=projectUserCenter({records},query());assert.equal(result.totalSize,2);assert.equal(result.totalScore,60);assert.equal(result.infoList[1].currentScore,40);assert.equal(result.infoList[1].totalHands,2);
 const hand=projectUserCenter({records},query({kind:'hands',roomId:700000,size:1,page:2}));assert.equal(hand.totalInning,2);assert.equal(hand.infoList.length,1);assert.equal(hand.infoList[0].currInning,1);assert.ok(Array.isArray(hand.infoList[0].firstGameList));
});

test('native hand cards accept stored JSON player lists and preserve card zero',()=>{
 const result=projectUserCenter({records:[record({detail:{firstGameList:JSON.stringify([
   {uid:42,score:-10,handPais:[0,2],commonPoker:[3,4,5]},
   {uid:43,score:10,handPais:[-1,-1],showCards:[-1,-1]}
 ])}})]},query({kind:'hands'}));
 assert.deepEqual(result.infoList[0].ownCards,[0,2]);assert.deepEqual(result.infoList[0].commonCards,[3,4,5]);
 assert.deepEqual(result.infoList[0].winCards,[-1,-1]);
 const three=projectUserCenter({records:[record({roomType:25,detail:{firstGameList:[
   {uid:42,score:20,handPais:[0,1,2],showCards:[-1,-1,-1]},
   {uid:43,score:-20,handPais:[-1,-1,-1],showCards:[-1,-1,-1]}
 ]}})]},query({kind:'hands',roomType:25}));
 assert.deepEqual(three.infoList[0].ownCards,[0,1,2]);assert.deepEqual(three.infoList[0].winCards,[0,1,2]);
});
test('personal data excludes other users, agents and currencies',()=>{
 const records=[record(),record({id:'other-user',userId:43}),record({id:'other-agent',agentId:8}),record({id:'other-currency',currency:'USD'})];
 const result=projectUserCenter({records},query());assert.equal(result.totalSize,1);assert.equal(result.totalScore,50);
});
test('fund detail uses actual settlement balance and never invents missing balances',()=>{
 const records=[record(),record({id:'unknown-old-balance',balance:undefined,net:100})];
 const funds=projectUserCenter({records},query({kind:'funds',roomType:0}));assert.equal(funds.count,1);assert.deepEqual(funds.logs[0],{id:'one',createTime:now-1000,sourceType:2,sourceId:700000,point:50,lastPoint:1050,roomType:19});
 assert.deepEqual(projectUserCenter({logs:[{id:'paid',point:-100,lastPoint:900,createTime:now}],total:31,paged:true},query({kind:'funds',page:3})),{count:31,pageNum:3,logs:[{id:'paid',point:-100,lastPoint:900,createTime:now}]});
});
test('bairen record and empty ticket views have iterable native fields',()=>{
 const result=projectUserCenter({records:[record({roomType:58,net:-50})]},query({roomType:58}));assert.equal(result.ownScore,-50);assert.equal(result.infoList[0].effectiveBet,100);
 assert.deepEqual(projectUserCenter({records:[]},query({kind:'tickets'})),{count:0,pageNum:1,logs:[]});
});
test('history requests authenticate before querying and reject uid spoofing',async t=>{
 t.mock.method(Date,'now',()=>now);let reads=0;
 const runtime={env:'prod',log:{error(){}},gateway:{authenticate:async token=>({success:token==='ok',userId:42}),getLoginData:async()=>({userId:42,agentId:7,currency:{symbol:'CNY'}}),getUserCenter:async()=>{reads++;return {records:[record()]};}}};
 for(const params of [{userId:42},{userId:42,token:'bad'},{userId:42,uid:43,token:'ok'}])assert.notEqual((await userCenterResponse(runtime,27,params)).msgCode,200);
 assert.equal(reads,0);assert.equal((await userCenterResponse(runtime,27,{userId:42,token:'ok',roomType:19})).data.totalSize,1);
 runtime.gateway.getUserCenter=async()=>{throw Object.assign(new Error('source offline'),{code:14,status:503});};const failure=await userCenterResponse(runtime,39,{userId:42,token:'ok'});assert.equal(failure.msgCode,503);assert.equal(failure.data,null);
});

test('hall default current-time filters share a fixed three-minute result cache while authentication and calendar scope remain fresh',async t=>{
  let clock=Date.UTC(2026,10,12,3),reads=0,auths=0,profiles=0;const cache=new Map(),writes=[];
  t.mock.method(Date,'now',()=>clock);
  const runtime={env:'prod',log:{error(){}},gateway:{authenticate:async token=>{auths++;return {success:token==='ok',userId:42};},
    getLoginData:async()=>{profiles++;return {userId:42,agentId:7,currency:{symbol:'CNY'}};},
    getUserCenter:async()=>{reads++;return {records:[]};}},bus:{getCache:async key=>{const v=cache.get(key);return v&&clock<v.until?v.raw:null;},
      setCache:async(key,raw,ttl)=>{writes.push({key,ttl});cache.set(key,{raw,until:clock+ttl*1000});}}};
  const params={userId:42,token:'ok',roomType:19};
  assert.equal((await userCenterResponse(runtime,27,params)).msgCode,200);
  clock+=1234;assert.equal((await userCenterResponse(runtime,27,{...params,pageNum:'1',endTime:'',endDateDiff:'0'})).msgCode,200);
  clock+=178765;await userCenterResponse(runtime,27,params);assert.equal(reads,1);assert.equal(writes.length,1);
  clock++;await userCenterResponse(runtime,27,params);assert.equal(reads,2);assert.equal(writes[0].ttl,180);
  assert.equal(auths,4);assert.equal(profiles,4,'cache must not bypass current account authorization');
  const before=reads;assert.equal((await userCenterResponse(runtime,27,{...params,token:'bad'})).msgCode,401);assert.equal(reads,before);
  const priorKey=writes.at(-1).key;
  clock=Date.UTC(2026,10,12,16)+1;await userCenterResponse(runtime,27,params);
  assert.notEqual(writes.at(-1).key,priorKey,'China calendar-day rollover needs a distinct default interval');
});

test('explicit historical end times remain distinct and are never normalized into a moving end',async t=>{
  t.mock.method(Date,'now',()=>now);const keys=[],cache=new Map();let reads=0;
  const runtime={env:'prod',log:{error(){}},gateway:{authenticate:async()=>({success:true,userId:42}),getLoginData:async()=>({userId:42,agentId:7,currency:{symbol:'CNY'}}),
    getUserCenter:async()=>{reads++;return {records:[]};}},bus:{getCache:async k=>cache.get(k),setCache:async(k,v)=>{keys.push(k);cache.set(k,v);}}};
  const params={userId:42,token:'ok',startTime:'2026-11-07 00:00:00'};
  await userCenterResponse(runtime,27,{...params,endTime:'2026-11-07 12:00:00'});
  await userCenterResponse(runtime,27,{...params,endTime:'2026-11-07 13:00:00'});
  await userCenterResponse(runtime,27,{...params,endTime:'2026-11-07 12:00:00'});
  assert.equal(reads,2);assert.equal(new Set(keys).size,2);
});
test('championship display counts only confirmed prizes and real participation',()=>{
 const row={id:9,agent_id:7,currency:'CNY',start_time:now-10000,end_time:now,state:3,championship_name:'event',current_player:2};
 const state={registrations:{42:{userId:42,name:'me',rank:1,status:'winner',receipt:{paidGold:100,paidService:10}},43:{userId:43,name:'other',rank:2,status:'eliminated'}},
  prizes:[{status:'paid',plan:{userId:42,kind:'money',amount:500,currency:'CNY'},receipt:{amount:500,currency:'CNY'}},{status:'pending',plan:{userId:42,kind:'money',amount:999,currency:'CNY'}}]};
 const result=userCenterMatch(row,state,query({kind:'matches'}));assert.equal(result.rewardAmount,500);assert.equal(result.net,390);assert.equal(result.MTTUserRanks.length,2);assert.equal(result.myUserRank.userName,'me');
 assert.equal(userCenterMatch(row,state,query({userId:99,kind:'matches'})),null);
});

test('native profile supplies the account name and existing normalized avatar after authentication',async()=>{
 let reads=0;
 const runtime={gateway:{authenticate:async(token,userId)=>({success:token==='ok',userId}),
   getLoginData:async userId=>{reads++;return {userId,userName:'player',agentId:7,userIcon:90024};}}};
 const response=await userCenterProfileResponse(runtime,{userId:42,uid:42,token:'ok'});
 assert.equal(response.msgCode,200);assert.deepEqual(response.data,{playerId:42,name:'player',imageUrl:'/avator/90024.png',clubId:7});
 for(const params of [{userId:42},{userId:42,token:'bad'},{userId:42,uid:43,token:'ok'}])assert.notEqual((await userCenterProfileResponse(runtime,params)).msgCode,200);
 assert.equal(reads,1);
 runtime.gateway.getLoginData=async userId=>({userId,userName:'player',agentId:7,imageUrl:'https://images.example/avatar.png'});
 assert.equal((await userCenterProfileResponse(runtime,{userId:42,token:'ok'})).data.imageUrl,'https://images.example/avatar.png');
});

test('resident hall refreshes a changed shared projection without restarting or altering historical results',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'gogame-user-center-hot-'));
 let runtime;
 t.after(async()=>{runtime?.userCenterProjection?.watcher?.close();await fs.rm(root,{recursive:true,force:true});});
 for(const dir of ['hall/src','shared','game-server/src/core'])await fs.mkdir(path.join(root,dir),{recursive:true});
 await fs.writeFile(path.join(root,'package.json'),'{"type":"module"}');
 for(const file of ['hall/src/user-center.js','hall/src/rel.js','hall/src/projection-watch.js'])await fs.copyFile(file,path.join(root,file));
 await fs.writeFile(path.join(root,'shared/hot-import.js'),'export const importHotModule=(location,version)=>{const url=new URL(location);url.searchParams.set("v",version);return import(url.href);};');
 await fs.writeFile(path.join(root,'hall/src/room-pool.js'),'export const requestRoomPool=()=>{throw new Error("prod must use gateway");};');
 await fs.writeFile(path.join(root,'game-server/src/core/member.js'),'export const userInfoOf=()=>({});');
 const sharedFile=path.join(root,'shared/user-center.js');
 await fs.copyFile('shared/history-query.js',path.join(root,'shared/history-query.js'));
 await fs.writeFile(sharedFile,'export const projectUserCenter=source=>({infoList:source.records.map(r=>r.detail)});');
 const mod=await import(pathToFileURL(path.join(root,'hall/src/user-center.js')).href+'?v=resident');
 const oldRecord=record({endedAt:Date.now()-1000,roomType:25,detail:{firstGameList:[
   {uid:42,score:-10,handPais:[0,1,2],showCards:[-1,-1,-1]},
   {uid:43,score:10,isWin:true,handPais:[-1,-1,5],showCards:[-1,-1,5]}
 ]}}),snapshot=structuredClone(oldRecord);
 runtime={env:'prod',log:{error(){}},gateway:{authenticate:async()=>({success:true,userId:42}),
   getLoginData:async()=>({userId:42,agentId:7,currency:{symbol:'CNY'}}),getUserCenter:async()=>({records:[oldRecord]})}};
 const params={userId:42,token:'ok',gameRoomId:700000};
 assert.equal((await mod.userCenterResponse(runtime,28,params)).data.infoList[0].ownCards,undefined);
 await fs.copyFile('shared/user-center.js',sharedFile);
 let response;
 for(let i=0;i<100;i++){
   response=await mod.userCenterResponse(runtime,28,params);
   if(response.data?.infoList?.[0]?.ownCards)break;
   await delay(20);
 }
 assert.equal(response.msgCode,200);assert.deepEqual(response.data.infoList[0].ownCards,[0,1,2]);
 assert.deepEqual(response.data.infoList[0].winCards,[-1,-1,5]);assert.equal(response.data.infoList[0].ownScore,oldRecord.net);
 assert.deepEqual(oldRecord,snapshot,'refreshing display code preserves the original settlement and balance');
});
