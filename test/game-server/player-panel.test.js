import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlayerPanel} from '../../game-server/src/core/player-panel.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {playerPanelStatistics,playerPanelWindows,playerPanelPersistedRecords,projectPlayerNotes} from '../../shared/player-panel.js';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createApp} from '../../hall/src/create-app.js';
import {createWallet} from '../../game-server/src/wallet/index.js';
import {findConfig} from '../../game-server/src/registry.js';
import {seedRooms} from '../../cache/rpc/seed.js';
import {finishHandStats} from '../../game-server/src/core/room-features.js';
import {recordRoomPlayerHand,roomPlayerPanelRecords} from '../../game-server/src/core/player-panel-records.js';

async function fixture(){
  const runtime={env:'dev',registry:createRegistry(),userCenterState:{records:new Map()}},panel=await createPlayerPanel(runtime);
  const table={roomId:700000,roomType:19,gameId:'holdem',agentId:7,members:[{uid:42,name:'Viewer'},{uid:43,name:'Target'},
    {uid:90000001,name:'Bot',bot:true}],observers:[],history:[],smallBlind:10,bigBlind:20};
  runtime.registry.setTable(table.roomId,table,7,'holdem');
  const session={userId:42,agentId:7,authenticated:true,inRoom:true,roomId:table.roomId,gameId:'holdem',currency:'CNY'};
  return {runtime,panel,table,session};
}
test('real panel statistics use settled hands and voluntary action rates rather than wallet or synthetic totals',async t=>{
  const now=Date.UTC(2026,10,7,10);t.mock.method(Date,'now',()=>now);
  const {runtime,panel,table,session}=await fixture();
  for(const [i,net,op]of [[1,100,8],[2,-40,7]])runtime.userCenterState.records.set(String(i),{
    id:String(i),userId:43,agentId:7,currency:'CNY',roomType:19,roomId:table.roomId,inning:i,endedAt:now-i*1000,net,
    balance:987654321,detail:{firstGameList:[{uid:43,userName:'Target',score:net,handPais:[10,11],showCards:[-1,-1],
      operateList:[{gameState:4,operate:op,bet:40}]},{uid:42,score:-net,showCards:[-1,-1],operateList:[]}]},
  });
  const data=await panel.profile(session,table,43);
  assert.equal(data.playerId,43);assert.equal(data.totalHands,2);assert.equal(data.todayScore,60);assert.equal(data.oneWeekScore,60);
  assert.equal(data.flipManualBetPercent,50);assert.equal(data.joinPercent,100);assert.equal(data.tableJoinPercent,100);
  assert.equal(data.oneWeekHands,2);assert.equal(data.tableMateRateList[0].uid,42);assert.equal(data.tableMateRateList[0].rate,100);
  assert.equal(data.balance,undefined);assert.equal(data.handPais,undefined);
  const records=await panel.records(session,table,43);
  assert.equal(records.totalInning,2);assert.deepEqual(records.infoList[0].ownCards,[-1,-1]);
  assert.ok(records.infoList.every(r=>!('gameEndData'in r)&&!('balance'in r)));
});
test('random robot profile is stored on the resident room and remains stable through service hot update',async()=>{
  const {runtime,panel,table,session}=await fixture();
  panel.syncRoomBots(table);assert.ok(table.playerPanelBots.has(90000001),'initial robot data belongs to the room after entry');
  const first=await panel.profile(session,table,90000001),again=await panel.profile(session,table,90000001);
  assert.deepEqual(again,first);assert.ok(table.playerPanelBots.has(90000001));
  const reloaded=await createPlayerPanel(runtime);assert.deepEqual(await reloaded.profile(session,table,90000001),first);
  assert.equal(runtime.userCenterState.records.size,0,'robot display data never enters real player persistence');
  assert.equal(first.oneWeekHands,0,'an unplayed robot has no fabricated hand history');
  assert.equal(first.recentRecordCount,0);assert.equal(first.recentRecordsAvailable,false,'simulated counters cannot fabricate real hand history');
  assert.ok(first.tableMateRateList.length>0);assert.ok(first.tableMateRateList.every(row=>row.rate>0&&row.flip3BetNum>0));
});

test('robot hand count and pages use only its actual settled hands in this resident room',async t=>{
  const now=Date.UTC(2026,10,7,10);t.mock.method(Date,'now',()=>now);
  const {runtime,panel,table,session}=await fixture(),uid=90000001;
  table.createdAt=now;table.kind='normal';table.currentInning=1;
  table.members[0].hole=[2,3];table.members[2].hole=[40,41];
  table.hand={statsPlayers:[table.members[0],table.members[2]],board:[4,5,6]};
  const results=[{uid:42,score:-10,showCards:[],xiaZhuData:10},{uid,score:10,isWin:true,showCards:[],xiaZhuData:10,walletAmount:999999}];
  finishHandStats(table,results);finishHandStats(table,results);
  assert.equal(table.playerPanelHands.size,1,'duplicate settlement does not append another report');
  table.currentInning=2;finishHandStats(table,[{uid:42,score:0},{uid:43,score:0}]);
  table.currentInning=3;table.hand={statsPlayers:[table.members[0],table.members[2]],board:[]};
  finishHandStats(table,[{uid:42,score:20,showCards:[2,3]},{uid,score:-20,showCards:[-1,41]}]);
  table.currentInning=4;table.hand={statsPlayers:table.members,board:[]};
  assert.equal(table.playerPanelHands.size,3,'an in-progress hand is not collected');
  runtime.userCenterState.records.set('foreign-bot',{userId:uid,roomId:800000,roomType:19,agentId:7,currency:'CNY',inning:500,endedAt:now,net:1000});
  const profile=await panel.profile(session,table,uid),first=await panel.records(session,table,uid,1,1),second=await panel.records(session,table,uid,2,1);
  assert.equal(profile.oneWeekHands,2);assert.equal(profile.recentRecordCount,2);assert.equal(profile.recentRecordScope,'room');
  assert.equal(first.totalInning,2);assert.equal(second.totalInning,2);assert.equal(first.ownScore,-10);
  assert.equal(first.infoList[0].currInning,3);assert.equal(second.infoList[0].currInning,1);
  assert.deepEqual(first.infoList[0].ownCards,[-1,41]);assert.deepEqual(second.infoList[0].ownCards,[-1,-1]);
  assert.deepEqual(second.infoList[0].firstGameList.find(p=>p.uid===42).handPais,[2,3],'the authenticated viewer can see only their own private hand');
  assert.ok(!JSON.stringify(first).includes('walletAmount'));
  assert.deepEqual(second.infoList[0].firstGameList.find(p=>p.uid===uid).handPais,[-1,-1]);
  const reloaded=await createPlayerPanel(runtime);
  assert.deepEqual(await reloaded.records(session,table,uid,2,1),second);
  assert.deepEqual(await reloaded.records(session,table,uid,3,1).then(p=>p.infoList),[]);
});

test('hot update recovers completed legacy robot room hands without a seven-day timestamp requirement',async()=>{
  const {panel,table,session}=await fixture(),uid=90000001;
  table.members[2].hole=[50,51];
  table.history=[{currentInningNum:1,firstGameList:[{uid,score:-10,cards:[10,11],showCards:[-1,-1]}]},
    {currentInningNum:2,innerEndTime:1,firstGameList:[{uid,score:20,cards:[20,21],showCards:[20,21]}]},
    {currentInningNum:3,firstGameList:[{uid:43,score:0}]}];
  const profile=await panel.profile(session,table,uid),page=await panel.records(session,table,uid);
  assert.equal(profile.oneWeekHands,2);assert.equal(page.totalInning,2);assert.equal(page.ownScore,10);
  assert.deepEqual(page.infoList.find(r=>r.currInning===1).ownCards,[-1,-1]);
  assert.equal(page.infoList.find(r=>r.currInning===1).endTime,0,'missing old timestamps are not invented');
  assert.deepEqual(roomPlayerPanelRecords(table,uid).find(r=>r.inning===1).players[0].handPais,[10,11],'historical cards never come from the current hand');
});

test('room-scoped robot records work in production without reading persistent player reports',async()=>{
  const {runtime,table,session}=await fixture();runtime.env='prod';
  const calls=[];runtime.gateway={playerPanel:async action=>{calls.push(action);assert.equal(action,'noteGet');return {};}};
  table.history=[{currentInningNum:1,innerEndTime:Date.now(),firstGameList:[{uid:90000001,score:30,showCards:[1,2]}]}];
  const panel=await createPlayerPanel(runtime);
  assert.equal((await panel.profile(session,table,90000001)).oneWeekHands,1);
  assert.equal((await panel.records(session,table,90000001)).infoList.length,1);
  assert.deepEqual(calls,['noteGet']);assert.equal(runtime.userCenterState.records.size,0);
});

test('non-Holdem room records retain their native public card shapes',async()=>{
  for(const [roomType,gameId,count]of [[24,'niuniu',5],[25,'zjh',3],[26,'jsmj',3],[27,'sss',13],[28,'csmj',13],[30,'hzxl',13],[31,'blackjack',3],[32,'sgay',3]]){
    const {panel,table,session}=await fixture();Object.assign(table,{roomType,gameId,currentInning:1});session.gameId=gameId;
    const cards=Array.from({length:count},(_,i)=>i),result={uid:90000001,score:25,showCards:cards,handPais:cards,handCards:cards,groupCards:[],
      evalResult:{frontHand:{cards:[0,1,2]},middleHand:{cards:[3,4,5,6,7]},backHand:{cards:[8,9,10,11,12]}},handResults:[{cards:[0,1,2]}],walletAmount:999};
    recordRoomPlayerHand(table,[result],{winUid:90000001,resultList:[result]});
    const profile=await panel.profile(session,table,90000001),page=await panel.records(session,table,90000001);
    assert.equal(profile.oneWeekHands,1);assert.equal(page.totalInning,1);assert.equal(page.infoList[0].roomType,roomType);
    if(roomType===25)assert.deepEqual(page.infoList[0].ownCards,[0,1,2]);
    else if([26,28,30].includes(roomType))assert.deepEqual(JSON.parse(page.infoList[0].gameEndData).resultList[0].handCards,cards);
    else assert.deepEqual(JSON.parse(page.infoList[0].firstGameList)[0].handPais,cards);
    assert.ok(!JSON.stringify(page).includes('walletAmount'));
  }
});

test('human records keep their real seven-day window and production non-Holdem query pagination',async t=>{
  const now=Date.UTC(2026,10,7,10);t.mock.method(Date,'now',()=>now);
  const {runtime,panel,table,session}=await fixture();
  for(const [i,time]of [[1,now],[2,1]])runtime.userCenterState.records.set(String(i),{userId:43,roomId:table.roomId,roomType:19,agentId:7,currency:'CNY',inning:i,endedAt:time,net:10,detail:{firstGameList:[]}});
  assert.equal((await panel.profile(session,table,43)).oneWeekHands,1);assert.equal((await panel.records(session,table,43)).totalInning,1);
  table.roomType=25;table.gameId='zjh';session.gameId='zjh';runtime.env='prod';const calls=[];
  runtime.gateway={async getUserCenter(query){calls.push(query);return {paged:true,total:22,totalScore:80,records:[{userId:43,roomType:25,roomId:123,inning:9,endedAt:now,net:20,
    players:[{uid:43,score:20}],detail:{firstGameList:[{uid:43,score:20,handPais:[40,41,42],showCards:[-1,-1,-1]}]}}]};}};
  const prod=await createPlayerPanel(runtime),page=await prod.records(session,table,43,2,1);
  assert.equal(page.totalInning,22);assert.equal(page.ownScore,80);assert.deepEqual(page.infoList[0].ownCards,[-1,-1,-1]);
  assert.equal(calls[0].page,2);assert.equal(calls[0].size,1);assert.equal(calls[0].roomType,25);assert.equal(calls[0].agentId,7);
  assert.equal(calls[0].startTime,playerPanelWindows(now).sevenDays);
});
test('non-Holdem robot avatar profiles use the same seated identity and stable nonzero statistics',async()=>{
 const {runtime,panel,table,session}=await fixture();table.roomType=25;table.gameId='zjh';session.gameId='zjh';
 table.members[2].name='Seat Robot';table.members[2].icon='/avator/90024.png';
 const profile=await panel.profile(session,table,90000001);
 assert.equal(profile.name,'Seat Robot');assert.equal(profile.imageUrl,'/avator/90024.png');
 assert.ok(profile.totalHands>0);assert.ok(profile.joinPercent>0);assert.ok(profile.todayScore!==0||profile.oneWeekScore!==0);
 assert.deepEqual(await (await createPlayerPanel(runtime)).profile(session,table,90000001),profile);
});
test('non-Holdem native HTTP op81651 selects the room target and does not replace the active player login',async t=>{
 const {runtime,table,session}=await fixture();table.roomType=25;table.gameId='zjh';session.gameId='zjh';table.kind='normal';
 runtime.registry.removeTable(table.roomId,7,'holdem');runtime.registry.setTable(table.roomId,table,7,'zjh');
 const gateway={validateToken:async token=>token==='valid',getLoginData:async userId=>({userId,agentId:7,currency:{symbol:'CNY'}})};
 Object.assign(runtime,{hotVersion:'other-avatar-http',configs:seedRooms(),findConfig,gateway,wallet:createWallet({mode:'local',local_balance:10000}),log:{info(){},error(){}}});
 const handler=await createHandler(runtime),active={readyState:1,send(){}};runtime.registry.bind(active,session);
 const game=http.createServer(),sockets=new WebSocketServer({server:game});
 sockets.on('connection',ws=>{ws.on('message',data=>void handler.onMessage(ws,data));ws.on('close',()=>void handler.onClose(ws));});
 await new Promise(resolve=>game.listen(0,'127.0.0.1',resolve));
 const app=await createApp({env:'dev',hotVersion:'other-avatar-http',config:{game_server:'127.0.0.1:'+game.address().port},gateway,
   matchStore:{listMatches:()=>[]},roomStore:{list:()=>runtime.configs},log:{error(){}}});
 const hall=http.createServer(app);await new Promise(resolve=>hall.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{for(const ws of sockets.clients)ws.terminate();sockets.close();await Promise.all([new Promise(resolve=>game.close(resolve)),new Promise(resolve=>hall.close(resolve))]);});
 const query=async extra=>(await fetch('http://127.0.0.1:'+hall.address().port+'/internal/v1/do?'+new URLSearchParams({op:81651,userId:42,uid:42,token:'valid',roomId:table.roomId,targetUid:90000001,...extra}))).json();
 const response=await query({});assert.equal(response.msgCode,200);assert.equal(response.data.playerId,90000001);assert.equal(response.data.name,'Bot');
 assert.ok(response.data.totalHands>0);assert.ok(response.data.todayScore!==0);assert.equal((await query({token:'bad'})).msgCode,401);
 assert.equal((await query({roomId:999})).msgCode,403);assert.equal(runtime.registry.session(active),session);assert.equal(runtime.registry.sessions.size,1);
 table.history.push({currentInningNum:1,innerEndTime:Date.now(),players:[{uid:90000001,score:50,showCards:[1,2,3],userInfo:{uid:90000001,name:'Bot'}}]});
 const records=await query({op:81652});assert.equal(records.msgCode,200);assert.equal(records.data.totalInning,1);
 assert.equal(records.data.roomTypeName,'ctjh');assert.deepEqual(records.data.infoList[0].ownCards,[1,2,3]);
 assert.equal((await query({op:81652,roomId:999})).msgCode,403);
 assert.equal((await query({op:81652,token:'bad'})).msgCode,401);
 assert.equal(runtime.registry.session(active),session);assert.equal(runtime.registry.sessions.size,1);
});
test('notes and marks are isolated by author and agent and partial updates preserve earlier fields',async()=>{
  const {runtime,panel,table,session}=await fixture();
  const note=await panel.remark(session,table,{targetId:43,remark:'Tight',remarkMessage:'check river',mark:2});
  assert.equal(note.targetUid,43);assert.equal(note.remarkName,'Tight');
  await panel.remark(session,table,{targetId:43,mark:0});
  assert.equal((await panel.profile(session,table,43)).remarkMessage,'check river');
  assert.equal((await panel.profile({...session,userId:43},table,43)).remarkName,'');
  const reloaded=await createPlayerPanel(runtime);assert.equal((await reloaded.profile(session,table,43)).remarkName,'Tight');
  for(const payload of [{targetId:43,mark:9},{targetId:43,remark:'x'.repeat(33)},{targetId:43,remark:'a;b'},{targetId:43,remarkMessage:'bad\nline'}])
    await assert.rejects(panel.remark(session,table,payload),{status:400});
  await assert.rejects(panel.profile({...session,agentId:8},table,43),{status:403});
  await assert.rejects(panel.profile(session,table,999),{status:404});
});
test('twenty ordinary props per player per China day are shared across requests and advanced props never spend balance',async t=>{
  let now=Date.UTC(2026,10,7,8);t.mock.method(Date,'now',()=>now);
  const {runtime,panel,table,session}=await fixture();session.wallet=5000;
  assert.equal(await panel.quota(session,table),20);
  const message={sendUid:42,type:5,content:{toId:43,propId:2}};
  const results=await Promise.all(Array.from({length:20},()=>panel.gift(session,table,message)));
  assert.deepEqual(results.map(r=>r.remaining),Array.from({length:20},(_,i)=>19-i));
  await assert.rejects(panel.gift(session,table,message),{status:409});assert.equal(await panel.quota(session,table),0);
  assert.equal(await (await createPlayerPanel(runtime)).quota(session,table),0);assert.equal(session.wallet,5000);
  await assert.rejects(panel.gift(session,table,{...message,type:6}),{status:501});
  await assert.rejects(panel.gift(session,table,{...message,sendUid:43}),{status:403});
  await assert.rejects(panel.gift(session,table,{...message,content:{toId:999,propId:2}}),{status:403});
  now+=86400000;assert.equal(await panel.quota(session,table),20);
  table.cfg={ban_emoji:'1'};await assert.rejects(panel.gift(session,table,message),{status:403});assert.equal(await panel.quota(session,table),20);
  table.cfg.ban_emoji='0';assert.equal((await panel.gift(session,table,{...message,content:{toId:43,propId:9}})).remaining,19);
  table.observers.push(table.members.shift());await assert.rejects(panel.gift(session,table,message),{status:403});
});
test('settled hand MySQL DTO omits wallet/private nested values and refuses to persist robots',()=>{
  const source={id:'hand',agentId:7,userId:42,currency:'CNY',roomType:19,roomId:700000,inning:1,endedAt:123456,net:30,balance:999,
    detail:{firstGameList:[{uid:42,score:30,handPais:[0,1],showCards:[],walletAmount:999,operateList:[{gameState:4,operate:8,bet:50,cards:[0,1],replayOrder:0}]}]}};
  const records=playerPanelPersistedRecords([source,{...source,userId:90000001}]);assert.equal(records.length,1);
  assert.equal(records[0].raised,true);assert.equal(records[0].voluntary,true);assert.equal(records[0].players[0].walletAmount,undefined);
  assert.equal(records[0].players[0].operateList[0].cards,undefined);assert.equal(records[0].balance,undefined);
});
test('private remarks project per viewer without mutating a shared room broadcast',()=>{
 const source={memberList:[{uid:43,userInfo:{uid:43,name:'Target',remarkName:''}}],userList:[{uid:43,userName:'Target',userInfo:{uid:43,name:'Target'}}]};
 const before=structuredClone(source),a=projectPlayerNotes(source,new Map([[43,{remarkName:'Private',remarkMessage:'mine',mark:2}]]));
 assert.equal(a.memberList[0].userInfo.remarkName,'Private');assert.equal(a.userList[0].userName,'Private');assert.deepEqual(source,before);
 assert.equal(projectPlayerNotes(source,new Map()),source);
});
test('an all-in call is voluntary but not counted as a preflop raise',()=>{
 const row={userId:42,roomId:1,net:0,endedAt:Date.now(),players:[{uid:42,operateList:[{gameState:4,operate:9,bet:20,isRaise:false}]}]};
 const stats=playerPanelStatistics([row],{targetId:42,roomId:1});assert.equal(stats.flipManualBetPercent,0);assert.equal(stats.joinPercent,100);
 const old={...row,players:[{uid:42,operateList:[{gameState:4,operate:9,bet:20}]}]};
 assert.equal(playerPanelStatistics([old],{targetId:42,roomId:1}).flipManualBetPercent,'--','older unknown all-in type must not invent a raise');
});
test('production panel delegates real profiles, notes and paginated records to data-center without memory fallback',async()=>{
 const {runtime,table,session}=await fixture(),calls=[];runtime.env='prod';
 runtime.gateway={async playerPanel(action,input){calls.push({action,input});
   if(action==='noteGet')return {remarkName:'Saved',remarkMessage:'MySQL',mark:1};
   if(action==='read')return {records:[],complete:false,statistics:{totalHands:25000,todayScore:123,oneWeekScore:456,oneWeekHands:1234}};
   if(action==='records')return {records:[{userId:43,roomId:700000,inning:123,endedAt:Date.now()-1000,net:50,
     players:[{uid:43,handPais:[10,11],showCards:[-1,-1],score:50,isWin:true},{uid:42,handPais:[0,1],showCards:[],score:-50}]}],
     total:1234,score:9876,paged:true};
   throw Object.assign(new Error('database unavailable'),{status:503});
 }};
 const panel=await createPlayerPanel(runtime),profile=await panel.profile(session,table,43);
 assert.equal(profile.totalHands,25000);assert.equal(profile.todayScore,123);assert.equal(profile.remarkName,'Saved');
 const page=await panel.records(session,table,43,2,1);
 assert.equal(page.infoList.length,1);assert.equal(page.totalInning,1234);assert.equal(page.ownScore,9876);
 assert.deepEqual(page.infoList[0].ownCards,[-1,-1]);
 const request=calls.find(c=>c.action==='records').input;assert.equal(request.userId,42);assert.equal(request.targetId,43);assert.equal(request.agentId,7);
 assert.equal(request.page,2);assert.equal(request.size,1);
 await assert.rejects(panel.quota(session,table),{status:503});
});
