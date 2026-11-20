import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {roomRuntimeFixture} from '../fixtures/hot-room-runtime.mjs';
import {createRegistry} from '../../game-server/src/registry.js';
import {collectibleRoomRuntimeFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

test('nine room runtime modules use factories while registry, session control and tournament owners stay outside',()=>{
  assert.equal(collectibleRoomRuntimeFiles.length,9);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleRoomRuntimeFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../game-server/src/registry.js','../../shared/session-revocation-listener.js','../../shared/session-revocation-listener.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('room clock, three-hand suspension and closure progress remain on the same table across source replacement',async()=>{
  const f=roomRuntimeFixture();try{
    f.write(0);const old=await f.load('core/room-lifecycle.js',0),table={kind:'normal',gameId:'holdem',roomType:19,createdAt:1000,phase:'idle',members:[],observers:[],humanPresenceSeen:true,emptySinceHands:1,roomFeatures:{totalHands:4},startAt:10000};
    old.initializeLifetime(table,2000);assert.equal(old.syncActivity(table,5000),false);const expiry=table.expiresAt;
    f.write(1);const next=await f.load('core/room-lifecycle.js',1);next.initializeLifetime(table,9000);assert.equal(table.createdAt,1000);assert.equal(table.expiresAt,expiry);assert.equal(next.syncActivity(table,9000),false);assert.equal(table.suspendedAt,5000);
    table.observers.push({uid:42,bot:false});assert.equal(next.syncActivity(table,10000),true);assert.equal(table.startAt,15000);assert.equal(table.emptySinceHands,undefined);assert.equal(table.expiresAt,expiry);
    table.observers=[];table.members=[{uid:42,point:300}];const closure=old.prepareClosure(table,11000);closure.payouts.get(42).credited=true;assert.equal(next.prepareClosure(table,12000),closure);assert.equal(closure.payouts.get(42).credited,true);assert.equal(closure.closedAt,11000);
  }finally{f.close();}
});

test('replacement room pools reuse allocation progress and cannot recreate an already used room number',async()=>{
  const f=roomRuntimeFixture();try{
    f.write(0);const old=await f.load('core/room-pool.js',0),registry=createRegistry(),game={id:'holdem',kind:'normal',maxPeople:()=>2,createTable(roomId,roomType,cfg){return {roomId,roomType,cfg,gameId:'holdem',kind:'normal',members:[],observers:[],phase:'idle'};}},runtime={registry},cfg={game_room_config_id:70,room_type:19,room_index:0,play_mode:0};
    const a=old.createRoomPool(runtime,()=>game),first=a.allocate(7,cfg,0,1000),table=registry.getTable(first.roomId,7,'holdem'),owner=registry.roomPoolState;
    registry.removeTable(table.roomId,7,'holdem');f.write(1);const next=await f.load('core/room-pool.js',1),b=next.createRoomPool(runtime,()=>game);
    assert.equal(registry.roomPoolState,owner);assert.equal(b.wasAllocated(first.roomId,19,7,cfg),true);const allocated=b.allocate(7,cfg,0,2000);assert.equal(allocated.roomId,first.roomId+1);assert.equal(allocated.createdAt,2000);
    assert.equal(a.wasAllocated(allocated.roomId,19,7,cfg),true);assert.equal(b.allocate(8,cfg,0,2000).roomId,first.roomId);
  }finally{f.close();}
});

test('replacement statistics modules do not count a settled hand twice or overwrite its original room record',async()=>{
  const f=roomRuntimeFixture();try{
    f.write(0);const old=await f.load('core/room-features.js',0),member={uid:42,name:'original',icon:90024,point:150,openingPoint:100,totalBet:50,hole:[1,2]},table={kind:'normal',agentId:7,gameId:'holdem',roomId:700000,roomType:19,currentInning:1,members:[member],observers:[],hand:{pot:50,statsPlayers:[member],board:[3,4,5]},roomRules:{},phase:'playing'};let completed=0;
    table.recordUserCenter=()=>completed++;const results=[{uid:42,score:50,xiaZhuData:50,showCards:[1,2]}];old.finishHandStats(table,results);
    const stats=table.roomFeatures,record=table.playerPanelHands.get(1);f.write(1);const next=await f.load('core/room-features.js',1);next.finishHandStats(table,results);const ranked=next.ranking(table);
    assert.equal(table.roomFeatures,stats);assert.equal(stats.totalHands,1);assert.equal(stats.totalStream,50);assert.equal(completed,1);assert.equal(table.playerPanelHands.get(1),record);assert.equal(ranked.userList[0].winLostScore,50);
  }finally{f.close();}
});

test('replacement subscription controllers preserve contexts, selected table and visitors for each trusted agent',async()=>{
  const f=roomRuntimeFixture();try{
    f.write(0);const old=await f.load('core/hundred-subscriptions.js',0),registry=createRegistry(),events=[];
    const game={id:'hundred',kind:'hundred',roomTypes:[50],createTable(roomId,roomType,cfg){return {roomId,roomType,cfg,gameId:'hundred',kind:'hundred',visitors:new Map()};},enter(table,session){table.visitors.set(session.userId,session);},onLeave({table,session}){table.visitors.delete(session.userId);events.push(table.roomId);}};
    const configs=[0,1].map(room_index=>({state:1,room_type:50,game_room_config_id:50,room_index})),runtime={registry,configs},io=()=>({broadcast(){}}),session={agentId:7,userId:42};
    const a=old.createHundredSubscriptions(runtime,()=>game,io),rooms=a.rooms(session,{roomType:50});a.select(session,rooms[0]);a.register(session,{roomType:50,roomIds:[rooms[1].roomId],customData:2});
    const original=session.hundredSubscriptions,entry=original.get(rooms[1].roomId);f.write(1);const next=await f.load('core/hundred-subscriptions.js',1),b=next.createHundredSubscriptions(runtime,()=>game,io);
    assert.equal(b.target(session,rooms[1].roomId,50),rooms[1]);assert.equal(b.context(session,rooms[1]),2);assert.equal(session.hundredSubscriptions,original);assert.equal(original.get(rooms[1].roomId),entry);
    b.unregister(session,{});assert.equal(b.target(session,rooms[0].roomId,50),rooms[0]);assert.equal(b.target(session,rooms[1].roomId,50),null);assert.deepEqual(events,[rooms[1].roomId]);assert.equal(rooms[0].visitors.has(42),true);
    const other={agentId:8,userId:42};assert.notEqual(b.rooms(other,{roomType:50})[0],rooms[0]);
  }finally{f.close();}
});

test('a pending banker boundary and a credited refund keep their original progress across replacement',async()=>{
  const f=roomRuntimeFixture(),gate=deferred(),started=deferred();try{
    f.write(0);const old=await f.load('core/hundred-banker.js',0),groups=[[1],[2]],table={roomId:7,roomType:58,inning:1},session={userId:42,agentId:7,currency:'CNY',wallet:100000};let debits=0,credits=0,fail=false,slow=true;
    const wallet={available:s=>s.wallet,debit(s,n){debits++;s.wallet-=n;return {ok:true};},credit(s,n){credits++;s.wallet+=n;return {ok:true};},async persist(){if(slow){slow=false;started.resolve();await gate.promise;}if(fail)throw Error('persist rejected');}},io={wallet,broadcast(){},sendUser(){}},ctx={table,session,wallet,io,send(){}};
    old.request(ctx,6133,{bankerType:1,amount:10000,maxWinLoseAmount:10000},groups);const pending=old.boundary(ctx,groups);await started.promise;
    const owner=table.hundredBankers;f.write(1);const next=await f.load('core/hundred-banker.js',1);assert.equal(next.boundary(ctx,groups),pending);assert.equal(debits,1);gate.resolve();await pending;assert.equal(table.hundredBankers,owner);
    next.request(ctx,6134,{bankerType:1},groups);table.inning++;fail=true;await assert.rejects(next.boundary(ctx,groups),/persist rejected/);assert.equal(credits,1);const refund=owner.refunds[0];assert.equal(refund.credited,true);
    f.write(2);const newest=await f.load('core/hundred-banker.js',2);fail=false;await newest.boundary(ctx,groups);assert.equal(credits,1);assert.equal(debits,1);assert.equal(session.wallet,100000);assert.equal(owner.refunds.length,0);assert.equal(owner.entries.length,0);
  }finally{gate.resolve();f.close();}
});

test('a pending fair-proof task remains unique after replacement and releases messages only after original persistence',async()=>{
  const f=roomRuntimeFixture(),gate=deferred();try{
    f.write(0);const old=await f.load('core/fair-code.js',0),table={roomId:7,roomType:19,gameId:'holdem',agentId:7,currentInning:1,createdAt:1,members:[{uid:42,pos:0},{uid:43,pos:1}],observers:[],hand:{deck:Array.from({length:52},(_,i)=>i),board:[5,6,7]}};let writes=0;const delivered=[];
    old.beginFairHand({env:'prod',wallet:{deliver(){}},broadcast(){},async writeFairProof(){writes++;await gate.promise;}},table,table.members,2);
    const record=table.fairCodes.get(1),code=record.notarizationCode,pending=old.flushFairProof(table),task=table.fairPersistence.task;
    old.deliverAfterFairProof(table,{},Buffer.from('cards'),()=>delivered.push('original'));
    f.write(1);const next=await f.load('core/fair-code.js',1);next.beginFairHand({broadcast(){assert.fail('duplicate commitment');}},table,table.members,2);const joined=next.flushFairProof(table);
    next.deliverAfterFairProof(table,{},Buffer.from('more'),()=>delivered.push('replacement'));assert.equal(table.fairPersistence.task,task);assert.equal(writes,1);assert.deepEqual(delivered,[]);
    gate.resolve();await Promise.all([pending,joined]);assert.deepEqual(delivered,['original','replacement']);assert.equal(table.fairCodes.get(1),record);assert.equal(record.notarizationCode,code);assert.equal(table.fairPersistence.task,null);
    next.finishFairHand(table,[{uid:42,showCards:[]},{uid:43,showCards:[]}]);await next.flushFairProof(table);const view=next.fairCodeDetail(table,42,1);assert.ok(view.pokerList[0].secretKey);assert.equal(view.pokerList[2].secretKey,'');assert.equal(next.fairCodeDetail(table,99,1),null);
  }finally{gate.resolve();f.close();}
});

test('robot replacement reuses resident profiles and simulated bankrolls without touching human money',async()=>{
  const f=roomRuntimeFixture();try{
    f.write(0);const old=await f.load('core/robot.js',0),now=Date.now(),bot={uid:90000001,pos:0,point:300,bot:true},profile={session:{userId:bot.uid,bot:true,wallet:700},wasSeated:true,seatedAt:now,waitingAt:now,canSitAt:now,carryAt:0},traffic={nextCheckAt:now+10000,nextUid:bot.uid+1,profiles:new Map([[bot.uid,profile]])};
    const table={kind:'normal',gameId:'test',roomType:19,roomId:7,createdAt:now,members:[bot],observers:[{uid:42,bot:false}],cfg:{},phase:'idle',robotTraffic:traffic},ctx={table,io:{}},game={config:{robotBehavior:{}},maxPeople:()=>3,minPeople:()=>2};old.tickRoom(game,ctx,now,()=>.5);
    f.write(1);const next=await f.load('core/robot.js',1);next.tickRoom(game,ctx,now+1,()=>.5);assert.equal(table.robotTraffic,traffic);assert.equal(traffic.profiles.get(bot.uid),profile);assert.equal(profile.session.wallet,700);assert.equal(bot.point,300);assert.equal(traffic.nextCheckAt,now+10000);
    const io={wallet:{debit(){assert.fail('human wallet used for robot');}}},human={userId:42};assert.equal(next.hundredWalletContext(io,human),io);const context=next.hundredWalletContext(io,profile.session);context.wallet.debit(profile.session,100);assert.equal(profile.session.wallet,600);
  }finally{f.close();}
});

test('released room runtime exports and simulated-wallet closures are collected while original room state survives',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-room-runtime.mjs','--room-runtime-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_ROOM_RUNTIME_GC/);
});
