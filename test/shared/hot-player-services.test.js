import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {playerServiceFixture} from '../fixtures/hot-player-services.mjs';
import {createRegistry} from '../../game-server/src/registry.js';
import {collectiblePlayerServiceFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function room(roomType=19){
  const table={agentId:7,roomId:700000,gameId:'holdem',roomType,kind:'normal',currentInning:1,createdAt:Date.now(),history:[],members:[{uid:42,name:'viewer',icon:90024,point:100,hole:[0,1]},{uid:43,name:'target',icon:90025,point:100,hole:[2,3]},{uid:90000001,name:'bot',icon:90026,point:100,hole:[4,5],bot:true}],observers:[]};
  const session={userId:42,agentId:7,currency:'CNY',authenticated:true,inRoom:true,roomId:700000,gameId:'holdem'},runtime={env:'dev',registry:createRegistry(),log:{error(){}}};runtime.registry.setTable(table.roomId,table,7,table.gameId);return {table,session,runtime};
}

test('six player service modules use factories without replacing resident RPC, registry or watcher owners',()=>{
  assert.equal(collectiblePlayerServiceFiles.length,6);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectiblePlayerServiceFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/rpc/index.js','../../game-server/src/registry.js','../../hall/src/projection-watch.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('robot identity, generated profile and actual room-only records stay stable across player-panel source changes',async()=>{
  const f=playerServiceFixture();try{
    const x=room();f.write(0);const old=await f.load('core/player-panel.js',0),a=await old.createPlayerPanel(x.runtime);a.syncRoomBots(x.table);
    const first=await a.profile(x.session,x.table,90000001),bots=x.table.playerPanelBots,stats=bots.get(90000001);
    x.table.playerPanelHands=new Map([[1,{roomId:700000,roomType:19,inning:1,endedAt:Date.now(),players:[{uid:90000001,score:10,handPais:[4,5],showCards:[-1,-1],xiaZhuData:10},{uid:42,score:-10,handPais:[0,1],showCards:[-1,-1]}],commonCards:[]}]]);
    f.write(1);const next=await f.load('core/player-panel.js',1),b=await next.createPlayerPanel(x.runtime),after=await b.profile(x.session,x.table,90000001);
    assert.equal(x.table.playerPanelBots,bots);assert.equal(bots.get(90000001),stats);assert.equal(after.name,first.name);assert.equal(after.imageUrl,first.imageUrl);assert.equal(after.totalHands,first.totalHands);assert.equal(after.todayScore,first.todayScore);assert.equal(after.recentRecordCount,1);
    const records=await b.records(x.session,x.table,90000001);assert.equal(records.totalInning,1);assert.deepEqual(records.infoList[0].ownCards,[-1,-1]);assert.equal(records.recentRecordScope,'room');
    const other={...x.table,roomId:700001,playerPanelBots:undefined,playerPanelHands:undefined,history:[]};const owner={...x.session,roomId:700001};assert.equal((await b.records(owner,other,90000001)).totalInning,0);
  }finally{f.close();}
});

test('notes, marks and the twenty-use daily ordinary-gift quota survive replacement without enabling advanced gifts',async()=>{
  const f=playerServiceFixture();try{
    const x=room();f.write(0);const old=await f.load('core/player-panel.js',0),a=await old.createPlayerPanel(x.runtime);await a.remark(x.session,x.table,{targetId:43,remark:'private label',remarkMessage:'original note',mark:2});
    const payload={type:5,sendUid:42,content:{toId:43,propId:1}};assert.equal((await a.gift(x.session,x.table,payload)).remaining,19);const notes=x.runtime.playerPanelLocalNotes;
    f.write(1);const next=await f.load('core/player-panel.js',1),b=await next.createPlayerPanel(x.runtime),profile=await b.profile(x.session,x.table,43);assert.equal(x.runtime.playerPanelLocalNotes,notes);assert.equal(profile.remarkName,'private label');assert.equal(profile.mark,2);assert.equal(await b.quota(x.session,x.table),19);
    for(let i=0;i<19;i++)await b.gift(x.session,x.table,payload);assert.equal(await a.quota(x.session,x.table),0);await assert.rejects(a.gift(x.session,x.table,payload),{status:409});await assert.rejects(b.gift(x.session,x.table,{...payload,type:6}),{status:501});assert.equal(await b.quota(x.session,x.table),0);
  }finally{f.close();}
});

test('old and new native record readers share an in-flight history query and keep the fixed three-minute cache deadline',async t=>{
  let now=Date.UTC(2026,10,19,2);t.mock.method(Date,'now',()=>now);const f=playerServiceFixture();let release;try{
    const x=room(25),cache=new Map(),writes=[];let queries=0;Object.assign(x.runtime,{env:'prod',gateway:{getUserCenter:async()=>{queries++;return new Promise(resolve=>{release=()=>resolve({records:[],total:0});});}},bus:{getCache:async key=>{const entry=cache.get(key);return entry&&entry.until>now?entry.raw:null;},setCache:async(key,raw,ttl)=>{writes.push(ttl);cache.set(key,{raw,until:now+ttl*1000});}}});
    f.write(0);const old=await f.load('core/player-panel.js',0),a=await old.createPlayerPanel(x.runtime),pending=a.records(x.session,x.table,43);await turn();
    const state=x.runtime.historyQueries;f.write(1);const next=await f.load('core/player-panel.js',1),b=await next.createPlayerPanel(x.runtime),second=b.records(x.session,x.table,43);await turn();assert.equal(queries,1);assert.equal(x.runtime.historyQueries,state);
    release();await Promise.all([pending,second]);assert.deepEqual(writes,[180]);const deadline=[...cache.values()][0].until;now+=1000;await b.records(x.session,x.table,43);assert.equal(queries,1);assert.equal([...cache.values()][0].until,deadline);assert.deepEqual(writes,[180]);assert.equal(state.pending.size,0);assert.equal(state.owners.size,0);
    await assert.rejects(b.records({...x.session,agentId:8},x.table,43),{status:403});assert.equal(queries,1);
  }finally{release?.();f.close();}
});

test('a pending original report batch stays unique after source replacement and ES failure logs once without retry',async()=>{
  const f=playerServiceFixture();let release;try{
    const x=room(),calls=[],errors=[];Object.assign(x.runtime,{env:'prod',gateway:{writeUserCenter:batch=>{calls.push(batch);return new Promise(resolve=>{release=resolve;});}},log:{error:(...args)=>errors.push(args)}});
    f.write(0);const old=await f.load('core/user-center.js',0),a=old.installUserCenter(x.runtime);x.table.hand={statsPlayers:x.table.members.slice(0,2),board:[],replayEvents:[],replayActions:[]};
    const results=[{uid:42,score:10,xiaZhuData:20,showCards:[]},{uid:43,score:-10,xiaZhuData:20,showCards:[]}];x.table.recordUserCenter(results);await turn();assert.equal(calls.length,1);const state=x.runtime.userCenterState,task=state.writeTask;
    f.write(1);const next=await f.load('core/user-center.js',1),b=next.installUserCenter(x.runtime);const joined=b.flush();await turn();assert.equal(state.writeTask,task);assert.equal(calls.length,1);x.table.recordUserCenter(results);await turn();assert.equal(calls.length,1);
    release({durable:false,stored:0});await Promise.all([task,joined]);assert.equal(errors.length,1);assert.equal(state.outgoing.size,0);assert.equal(x.runtime.userCenterState,state);await b.flush();await a.flush();assert.equal(calls.length,1);assert.equal(state.records.size,2);
    const q={userId:42,agentId:7,currency:'CNY',kind:'hands',roomType:19,roomId:700000,startTime:1,endTime:Date.now(),page:1,size:10};const own=b.project(b.query(q),q).infoList[0];assert.deepEqual(own.ownCards,[0,1]);assert.deepEqual(own.firstGameList.find(p=>p.uid===43).handPais,[-1,-1]);
  }finally{release?.({durable:false,stored:0});f.close();}
});

test('tournament per-hand recording stays disabled across source replacement',async()=>{
 const f=playerServiceFixture();try{
 const x=room(101),writes=[];Object.assign(x.table,{mtt:{checkedInning:1,config:{currency:'CNY'}},hand:{statsPlayers:x.table.members.slice(0,2),board:[]}});Object.assign(x.runtime,{env:'prod',gateway:{writeUserCenter:async rows=>{writes.push(rows);return {durable:true,stored:rows.length}}}});
 for(let revision=0;revision<2;revision++){f.write(revision);const module=await f.load('core/user-center.js',revision),center=module.installUserCenter(x.runtime);x.table.recordUserCenter([{uid:42,score:10,xiaZhuData:20}]);await center.flush();assert.equal(writes.length,0);assert.equal(x.table.userCenterReportsReady(),true);assert.equal(x.runtime.userCenterState.outgoing.size,0);}
 }finally{f.close();}
});

test('match history uses only original confirmed payments, refunds and rewards across projection replacement',async()=>{
  const f=playerServiceFixture();try{
    f.write(0);const old=await f.load('shared/user-center-matches.js',0),now=Date.now(),row={id:9,agent_id:7,currency:'CNY',start_time:now-1000,state:3},state={registrations:{42:{userId:42,rank:1,status:'paid',receipt:{paidGold:100,paidService:20},reentries:[{receipt:{paidGold:100,paidService:20}}]}},prizes:[{status:'paid',plan:{kind:'money',userId:42,currency:'CNY',amount:300},receipt:{amount:300,currency:'CNY'}},{status:'pending',plan:{kind:'money',userId:42,currency:'CNY',amount:999}}]},query={userId:42,agentId:7,currency:'CNY',startTime:now-2000,endTime:now,kind:'match',roomId:9};
    const first=old.userCenterMatch(row,state,query);assert.equal(first.rewardAmount,300);assert.equal(first.net,60);
    f.write(1);const next=await f.load('shared/user-center-matches.js',1);assert.deepEqual(next.userCenterMatch(row,state,query),first);assert.equal(next.userCenterMatch(row,state,{...query,agentId:8}),null);assert.equal(next.userCenterMatch(row,state,{...query,userId:43}),null);
  }finally{f.close();}
});

test('released player services and projections are collected while original room profiles and stores remain',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-player-services.mjs','--player-service-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_PLAYER_SERVICES_GC/);
});
