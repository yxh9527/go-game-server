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

test('native lobby registration charges the game wallet; deadline refunds both fees; free match starts real tables', {timeout:20000},async()=>{
  const resources=[],log={info(){},warn(){},error(){}};
  async function serve(app){const s=http.createServer(app);await new Promise(r=>s.listen(0,'127.0.0.1',r));resources.push(()=>new Promise(r=>{s.closeAllConnections();s.close(r);}));return {s,address:'127.0.0.1:'+s.address().port};}
  try{
    const balances=new Map(),calls={debit:0,credit:0};
    const gateway={authenticate:async(_t,id)=>({success:true,userId:id}),validateToken:async()=>true,getLoginData:async id=>({agentId:1,userName:'user'+id})};
    const gameStore=createMemoryStore(),gameRuntime={env:'dev',hotVersion:'network-test',config:{tournament_cleanup_delay_ms:0},log,registry:createRegistry(),findConfig,configs:await gameStore.listRooms(),gateway,
      wallet:{load:async s=>{s.wallet=balances.get(s.userId)??1000;},persist:async()=>{},
        debit:(s,n)=>{calls.debit++;if(s.wallet<n)return {ok:false};s.wallet-=n;balances.set(s.userId,s.wallet);return {ok:true};},
        credit:(s,n)=>{calls.credit++;s.wallet+=n;balances.set(s.userId,s.wallet);return {ok:true};}}};
    let handler=await createHandler(gameRuntime);const game=await serve((_q,r)=>r.end('ok'));
    const wss=new WebSocketServer({server:game.s});resources.push(()=>new Promise(r=>{for(const ws of wss.clients)ws.terminate();wss.close(r);}));
    wss.on('connection',ws=>{ws.on('message',raw=>handler.onMessage(ws,raw));ws.on('close',()=>handler.onClose(ws));});
    let now=Date.now();gameRuntime.clock=()=>now;const matchRuntime={env:'dev',hotVersion:'network-test',config:{game_server:game.address,tournament_scheduler:false},clock:()=>now,store:createMemoryStore(),log,
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
    assert.equal(calls.credit,2);assert.equal((await request(54,10001)).data.walletAmount,1000);
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
    for(const member of table.members)member.openingPoint=member.point;
    table.members[0].point=20000;table.members[1].point=0;table.mtt.paused=true;table.phase='idle';table.startAt=0;
    await app.locals.tournaments.tick();await app.locals.tournaments.tick();await app.locals.tournaments.tick();
    assert.equal((await request(54,10001)).data.walletAmount,1050);
    assert.equal(calls.credit,3,'two refunds and exactly one configured prize');
    assert.equal((await app.locals.tournaments.inspect(free.id)).state.awardsNotified,true);
    assert.equal((await app.locals.tournaments.inspect(free.id)).state.tablesReleased,true);
    assert.equal(gameRuntime.tournamentRooms.matches.size,0);assert.equal(gameRuntime.registry.tables.size,0);
    const interrupted=await admin({agent_id:1,init_point:10000,min_player:2,state:1,start_time:now+60000,register_gold:100,service_gold:10,small_blind:5,big_blind:10});
    for(const uid of [10001,10002])assert.equal((await request(42,uid,{type:2,championshipsConfigId:interrupted.id})).msgCode,200);
    now+=60000;await app.locals.tournaments.tick();
    assert.equal((await app.locals.tournaments.inspect(interrupted.id)).row.state,2);
    // Simulate replacement of the game process's volatile room registry. The
    // shared test authority keeps the actual paid wallet balances unchanged.
    for(const table of [...gameRuntime.registry.tables.values()])gameRuntime.registry.removeTable(table.roomId,table.agentId,table.gameId);
    delete gameRuntime.tournamentRooms;handler=await createHandler(gameRuntime);
    await app.locals.tournaments.tick();await app.locals.tournaments.tick();
    const invalid=await app.locals.tournaments.inspect(interrupted.id);
    assert.equal(invalid.row.state,4);assert.equal(invalid.state.invalidated.reason,'GAME_STATE_LOST');
    assert.equal(invalid.state.registrations[10001].refund.refunded,110);
    assert.equal((await request(54,10001)).data.walletAmount,1050);assert.equal((await request(54,10002)).data.walletAmount,1000);
    assert.equal(calls.credit,5,'the invalid match returns both full fees once');
    const lateMatch=await admin({agent_id:1,init_point:10000,min_player:2,max_player:9,state:1,start_time:now+60000,register_gold:100,service_gold:10,
      delay_register_level:2,delay_register_time:300,small_blind:5,big_blind:10});
    for(const uid of [10001,10002])assert.equal((await request(42,uid,{type:2,championshipsConfigId:lateMatch.id})).msgCode,200);
    now+=60000;await app.locals.tournaments.tick();
    const lateRoom=(await app.locals.tournaments.inspect(lateMatch.id)).state.tables[0].room_id;
    const lateTable=gameRuntime.registry.getTable(lateRoom,1,'holdem'),beforeLate=calls.debit;
    assert.equal((await request(42,10003,{type:2,championshipsConfigId:lateMatch.id})).msgCode,200);
    assert.equal((await request(42,10003,{type:2,championshipsConfigId:lateMatch.id})).msgCode,200);
    assert.equal(calls.debit,beforeLate+1);assert.equal(lateTable.members.length,2);
    lateTable.mtt.paused=true;lateTable.phase='idle';lateTable.startAt=0;await app.locals.tournaments.tick();
    assert.equal(lateTable.members.length,3);assert.equal(lateTable.members.reduce((n,p)=>n+p.point,0),30000);
    assert.equal((await app.locals.tournaments.inspect(lateMatch.id)).state.registrations[10003].status,'playing');
    assert.equal((await request(54,10003)).data.walletAmount,890);
    now+=300000;assert.equal((await request(42,10004,{type:2,championshipsConfigId:lateMatch.id})).msgCode,409);
    assert.equal(calls.debit,beforeLate+1);
    const revival=await admin({agent_id:1,init_point:10000,min_player:2,state:1,start_time:now+60000,register_gold:100,service_gold:10,
      rebuy_time:1,delay_register_level:2,delay_register_time:300,small_blind:5,big_blind:10});
    for(const uid of [10001,10002])assert.equal((await request(42,uid,{type:2,championshipsConfigId:revival.id})).msgCode,200);
    now+=60000;await app.locals.tournaments.tick();
    const revivalRoom=(await app.locals.tournaments.inspect(revival.id)).state.tables[0].room_id;
    const revivalTable=gameRuntime.registry.getTable(revivalRoom,1,'holdem');
    for(const member of revivalTable.members)member.openingPoint=member.point;
    revivalTable.members[0].point=20000;revivalTable.members[1].point=0;revivalTable.phase='idle';revivalTable.startAt=0;revivalTable.mtt.paused=true;
    await app.locals.tournaments.tick();assert.equal((await app.locals.tournaments.inspect(revival.id)).row.state,2,'last survivor waits during the revival window');
    const beforeRevival=calls.debit;
    const beforeRevivalBalance=(await request(54,10002)).data.walletAmount;
    assert.equal((await request(48,10002,{type:2,championshipsConfigId:revival.id})).msgCode,200);
    assert.equal((await request(48,10002,{type:2,championshipsConfigId:revival.id})).msgCode,200);
    assert.equal(calls.debit,beforeRevival+1);
    await app.locals.tournaments.tick();
    const revived=(await app.locals.tournaments.inspect(revival.id)).state.registrations[10002];
    assert.equal(revived.status,'playing');assert.equal(revived.reentries[0].status,'admitted');
    assert.equal(revivalTable.members.reduce((n,p)=>n+p.point,0),30000);
    assert.equal((await request(54,10002)).data.walletAmount,beforeRevivalBalance-110);
    assert.equal((await request(48,10002,{type:2,championshipsConfigId:revival.id})).msgCode,200);assert.equal(calls.debit,beforeRevival+1);
    revivalTable.startAt=0;await handler.tick();assert.ok(revivalTable.hand,'termination must handle an actual in-progress hand');
    const denied=await fetch('http://'+match.address+'/internal/v1/tournament',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'terminate',matchId:revival.id,userId:10001,token:'dev'})});
    assert.equal(denied.status,400);assert.equal((await app.locals.tournaments.inspect(revival.id)).row.state,2);
    const refundCalls=calls.credit,beforeAdminOne=balances.get(10001),beforeAdminTwo=balances.get(10002);
    const stop=async()=>(await fetch('http://'+match.address+'/admin/v1/matches/'+revival.id+'/terminate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:'operator ends this match'})})).json();
    const stopped=await stop();assert.equal(stopped.code,0);assert.equal(stopped.data.state,4);assert.equal(stopped.data.refundsPending,0);assert.equal(stopped.data.tableCleanupPending,false);
    assert.equal(revivalTable.hand,null);assert.equal(gameRuntime.registry.getTable(revivalRoom,1,'holdem'),null);
    assert.equal(balances.get(10001),beforeAdminOne+110);assert.equal(balances.get(10002),beforeAdminTwo+220);assert.equal(calls.credit,refundCalls+3);
    assert.equal((await stop()).code,0);await app.locals.tournaments.tick();assert.equal(calls.credit,refundCalls+3);
    const audit=(await app.locals.tournaments.inspect(revival.id)).state.termination;assert.equal(audit.reason,'operator ends this match');assert.deepEqual(audit.actor,{agentId:1,kind:'dev'});
  }finally{for(const dispose of resources.reverse())await dispose();}
});

test('native ticket selection uses coupons first and pays the remaining or full amount from cash',async t=>{
  const resources=[],inventory=new Map([[10001,21],[10002,21],[10003,0]]),balances=new Map([[10001,1000],[10002,80],[10003,500]]),ledger=new Map();let charges=0;
  const log={info(){},error(){},warn(){}},gateway={authenticate:async(_token,id)=>({success:true,userId:id}),getLoginData:async()=>({agentId:1,currency:{symbol:'CNY'}})};
  const payments={async charge(p){
    assert.equal(p.ticketOnly,undefined);assert.equal(p.ticketCredit,true);
    if(ledger.has(p.key))return ledger.get(p.key);
    const available=inventory.get(p.userId)||0;
    if(available<p.ticketCount)throw Object.assign(new Error('required tickets missing'),{status:409});
    const count=Math.min(p.total,available-p.ticketCount),cash=p.total-count,used=p.ticketCount+count;
    if((balances.get(p.userId)||0)<cash)throw Object.assign(new Error('cash difference is insufficient'),{status:409});
    charges++;inventory.set(p.userId,available-used);balances.set(p.userId,balances.get(p.userId)-cash);
    const goldCredit=Math.min(p.gold,count);
    const receipt={key:p.key,currency:p.currency,grossGold:p.gold,grossService:p.service,paidGold:p.gold-goldCredit,paidService:p.service-(count-goldCredit),paidTicketCount:used,
      ticketId:p.ticketId,ticketCreditAmount:count,creditTicketCount:count,ticketRate:'100'};ledger.set(p.key,receipt);return receipt;
  },async refund(p){const receipt=ledger.get(p.key);if(receipt.refund)return receipt.refund;
    const cash=receipt.paidGold+receipt.paidService;inventory.set(p.userId,inventory.get(p.userId)+receipt.paidTicketCount);balances.set(p.userId,balances.get(p.userId)+cash);
    return receipt.refund={key:p.key,currency:p.currency,refunded:cash,restoredTickets:receipt.paidTicketCount};}};
  const runtime={env:'dev',hotVersion:'ticket-cash-http',config:{tournament_scheduler:false},store:createMemoryStore(),bus:{publish:async()=>{}},rpc:{gateway,common:{}},matchPayments:payments,log};
  async function serve(app){const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));resources.push(server);return 'http://127.0.0.1:'+server.address().port;}
  t.after(async()=>{for(const server of resources.reverse())await new Promise(resolve=>{server.closeAllConnections();server.close(resolve);});});
  const app=await matchApp(runtime),match=await serve(app);
  const hall=await serve(await hallApp({env:'dev',hotVersion:'ticket-cash-http',config:{match_server:match},log,gateway,
    rpc:{gateway,common:{getBalance:async uid=>balances.get(uid)},lobby:{countUnusedTickets:async uid=>inventory.get(uid)||0}},matchStore:createMatchStore(),roomStore:createRoomStore()}));
  async function create(required){const body=await (await fetch(match+'/admin/v1/matches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({agent_id:1,init_point:10000,min_player:2,state:1,start_time:Date.now()+60000,
    register_type:3,register_gold:100,service_gold:10,ticket_id:5,register_ticket:required,allow_ticket_pay:1,small_blind:5,big_blind:10})})).json();assert.equal(body.code,0);return body.data.id;}
  const id=await create(1),request=async(op,userId,type=1,matchId=id)=>(await fetch(hall+'/api/internal/v1/do?'+new URLSearchParams({op,userId,type,token:'dev',championshipsConfigId:matchId}))).json();
  assert.equal((await request(42,10001)).msgCode,200);assert.equal((await request(42,10001,2)).msgCode,200);assert.equal(charges,1);assert.equal(inventory.get(10001),0);assert.equal(balances.get(10001),910);
  assert.equal((await request(42,10002)).msgCode,409);assert.equal(inventory.get(10002),21);assert.equal(balances.get(10002),80);assert.equal(charges,1);
  assert.equal((await request(43,10001)).msgCode,200);assert.equal(inventory.get(10001),21);assert.equal(balances.get(10001),1000);
  const noRequired=await create(0);assert.equal((await request(42,10003,1,noRequired)).msgCode,200);assert.equal(balances.get(10003),390);assert.equal(inventory.get(10003),0);
  assert.equal((await request(43,10003,1,noRequired)).msgCode,200);assert.equal(balances.get(10003),500);
});
