import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createApp as matchApp } from '../../match/src/create-app.js';
import { createApp as hallApp } from '../../hall/src/create-app.js';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createMemoryStore } from '../../cache/rpc/store.js';
import { createRegistry,findConfig } from '../../game-server/src/registry.js';
import { createMatchStore,createRoomStore } from '../../hall/src/store.js';

test('native lobby registration charges the game wallet; deadline refunds retain service fees; free match starts real tables', {timeout:20000},async()=>{
  const resources=[],log={info(){},warn(){},error(){}};
  async function serve(app){const s=http.createServer(app);await new Promise(r=>s.listen(0,'127.0.0.1',r));resources.push(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {s,address:'127.0.0.1:'+s.address().port};}
  try{
    const balances=new Map(),calls={debit:0,credit:0};
    const gateway={authenticate:async(_t,id)=>({success:true,userId:id}),validateToken:async()=>true,getLoginData:async id=>({agentId:1,userName:'user'+id})};
    const gameStore=createMemoryStore(),gameRuntime={env:'dev',hotVersion:'network-test',config:{},log,registry:createRegistry(),findConfig,configs:await gameStore.listRooms(),gateway,
      wallet:{load:async s=>{s.wallet=balances.get(s.userId)??1000;},persist:async()=>{},
        debit:(s,n)=>{calls.debit++;if(s.wallet<n)return {ok:false};s.wallet-=n;balances.set(s.userId,s.wallet);return {ok:true};},
        credit:(s,n)=>{calls.credit++;s.wallet+=n;balances.set(s.userId,s.wallet);return {ok:true};}}};
    const handler=await createHandler(gameRuntime),game=await serve((_q,r)=>r.end('ok'));
    const wss=new WebSocketServer({server:game.s});resources.push(()=>new Promise(r=>{for(const ws of wss.clients)ws.terminate();wss.close(r);}));
    wss.on('connection',ws=>{ws.on('message',raw=>handler.onMessage(ws,raw));ws.on('close',()=>handler.onClose(ws));});
    let now=Date.now();const matchRuntime={env:'dev',hotVersion:'network-test',config:{game_server:game.address,tournament_scheduler:false},clock:()=>now,store:createMemoryStore(),log,
      rpc:{gateway,common:{debit(){assert.fail('match-local wallet must never be charged');}}},bus:{publish:async()=>{}}};
    const app=await matchApp(matchRuntime),match=await serve(app),roomStore=createRoomStore();roomStore.replace(await gameStore.listRooms());
    const hall=await serve(await hallApp({env:'dev',hotVersion:'network-test',config:{game_server:game.address,match_server:match.address},log,
      gateway,rpc:{gateway,common:{getBalance:async()=>777},lobby:{countUnusedTickets:async()=>0}},matchStore:createMatchStore(),roomStore}));
    async function admin(body){const r=await fetch('http://'+match.address+'/admin/v1/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const b=await r.json();assert.equal(b.code,0,JSON.stringify(b));return b.data;}
    async function request(op,uid,more={}){const q=new URLSearchParams({op,userId:uid,token:'dev-'+uid,...more});return (await fetch('http://'+hall.address+'/api/internal/v1/do?'+q)).json();}
    const paid=await admin({agent_id:1,init_point:10000,min_player:3,state:1,start_time:now+60000,register_gold:100,service_gold:10,small_blind:5,big_blind:10});
    for(const uid of [10001,10002])assert.equal((await request(42,uid,{type:2,championshipsConfigId:paid.id})).msgCode,200);
    assert.equal((await request(42,10001,{type:2,championshipsConfigId:paid.id})).msgCode,200);
    assert.equal(calls.debit,2);
    assert.equal((await request(54,10001)).data.walletAmount,890);
    now+=60000;await app.locals.tournaments.tick();await app.locals.tournaments.tick();
    assert.equal(calls.credit,2);assert.equal((await request(54,10001)).data.walletAmount,990);
    assert.equal((await app.locals.tournaments.inspect(paid.id)).row.state,4);
    const free=await admin({agent_id:1,init_point:10000,min_player:2,state:1,start_time:now+60000,register_gold:0,service_gold:0,small_blind:5,big_blind:10,
      award_json:[{rank:1,items:[{kind:'money',currency:'CNY',amount:'50'}]}]});
    for(const uid of [10001,10002])assert.equal((await request(42,uid,{type:2,championshipsConfigId:free.id})).msgCode,200);
    now+=60000;await app.locals.tournaments.tick();
    const detail=await request(36,10001,{championshipsConfigId:free.id});
    assert.equal(detail.data.playerStatus,4);assert.equal(detail.data.currentLivePlayer,2);
    assert.equal(detail.data.MTTRoomInfos[0].playerNums,2);
    assert.equal(detail.data.MTTRankPrices[0].price,50);
    assert.deepEqual(detail.data.blindConfig,['1/5/10']);
    assert.deepEqual(detail.data.MTTUserRanks.map(p=>p.userId),[10001,10002]);
    assert.ok(detail.data.MTTUserRanks.every(p=>p.userName&&p.icon&&p.point===10000));
    const table=gameRuntime.registry.getTable(detail.data.MTTRoomInfos[0].roomId,1,'holdem');
    assert.equal(table.roomType,101);assert.equal(table.members.length,2);assert.equal(calls.debit,2);
    // Feed a completed, chip-conserving checkpoint into the real control/payment bridge.
    table.members[0].point=20000;table.members[1].point=0;table.mtt.paused=true;table.phase='idle';table.startAt=0;
    await app.locals.tournaments.tick();await app.locals.tournaments.tick();await app.locals.tournaments.tick();
    assert.equal((await request(54,10001)).data.walletAmount,1040);
    assert.equal(calls.credit,3,'two refunds and exactly one configured prize');
    assert.equal((await app.locals.tournaments.inspect(free.id)).state.awardsNotified,true);
  }finally{for(const dispose of resources.reverse())await dispose();}
});
