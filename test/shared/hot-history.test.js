import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {historyFixture} from '../fixtures/hot-history.mjs';
import {createCollectibleEntryLoader,collectibleHistoryFiles,collectibleModuleFiles} from '../../shared/hot-entry-factory.js';

test('reviewed history modules retain runtime state ownership and exclude resident financial transports',()=>{
  assert.equal(collectibleHistoryFiles.length,11);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleHistoryFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/rpc/env.js','../../shared/session-revocation-listener.js','../../game-server/src/registry.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('history query versions share pending requests, original 180-second cache and owner cleanup across replacement',async()=>{
  const f=historyFixture();try{
    f.write(0);const old=await f.load('shared/history-query.js',0);let release,reads=0;
    const cache=new Map(),writes=[],runtime={gateway:{getUserCenter:query=>{reads++;return new Promise(resolve=>{release=()=>resolve({records:[],total:0,query});});}},bus:{getCache:async key=>cache.get(key),setCache:async(key,value,ttl)=>{cache.set(key,value);writes.push(ttl);}}};
    const query={kind:'hands',userId:42,agentId:7,currency:'CNY',roomType:25,roomId:700001,startTime:1,endTime:1000};
    const pending=old.queryHistory(runtime,query);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
    const owners=runtime.historyQueries.owners,pendingMap=runtime.historyQueries.pending;
    f.write(1);const next=await f.load('shared/history-query.js',1);assert.notEqual(next.queryHistory,old.queryHistory);
    const joined=next.queryHistory(runtime,query);release();const [a,b]=await Promise.all([pending,joined]);assert.equal(a,b);assert.equal(reads,1);assert.deepEqual(writes,[180]);
    assert.equal(runtime.historyQueries.pending,pendingMap);assert.equal(runtime.historyQueries.owners,owners);assert.equal(pendingMap.size,0);assert.equal(owners.size,0);
    await next.queryHistory(runtime,query);await old.queryHistory(runtime,query);assert.equal(reads,1);assert.deepEqual(writes,[180],'cache hits must not renew TTL');
    runtime.gateway.getUserCenter=async()=>{throw Error('history offline');};await assert.rejects(next.queryHistory(runtime,{...query,userId:43}),/history offline/);assert.equal(pendingMap.size,0);assert.equal(owners.size,0);
  }finally{f.close();}
});

test('old and new replay graphs coalesce pending reads and preserve hidden opponent cards without new financial calls',async()=>{
  const f=historyFixture();try{
    f.write(0);const old=await f.load('shared/holdem-replay-store.js',0);
    const table={roomId:700001,currentInning:5,smallBlind:5,bigBlind:10,members:[{uid:42,name:'owner',hole:[1,2],pos:0},{uid:43,name:'opponent',hole:[3,4],pos:1}]};
    const hand={participants:table.members,board:[10,11,12,13,14],pot:40,replayActions:[{uid:43,replayOrder:1,gameState:4,operationType:7,bet:20,cards:[3,4]}],replayEvents:[]};
    const results=[{uid:42,score:20,isWin:true,showCards:[1,2]},{uid:43,score:-20,showCards:[]}];
    const replay=old.captureHoldemReplay(table,hand,results,42),record={userId:42,agentId:7,currency:'CNY',roomType:19,roomId:table.roomId,inning:5,detail:{replay}};
    let reads=0,release;const cache=new Map(),writes=[],runtime={wallet:{run(){assert.fail('history attempted a financial call');}},gateway:{getUserCenter:async()=>{reads++;await new Promise(resolve=>{release=resolve;});return {records:[record,{...record,userId:43}]};}},bus:{getCache:async key=>cache.get(key),setCache:async(key,value,ttl)=>{writes.push(ttl);cache.set(key,value);}}};
    const account={userId:42,agentId:7,currency:'CNY'},request={roomId:table.roomId,inningNum:5};
    const pending=old.queryHoldemReplay(runtime,account,request,true);await new Promise(resolve=>setImmediate(resolve));assert.equal(reads,1);
    f.write(1);const next=await f.load('shared/holdem-replay-store.js',1);const joined=next.queryHoldemReplay(runtime,account,request,true);release();
    const [a,b]=await Promise.all([pending,joined]);assert.equal(a,b);assert.equal(reads,1);assert.deepEqual(writes,[180]);assert.equal(runtime.holdemReplayReads.pending.size,0);assert.equal(runtime.historyQueries.pending.size,0);
    const players=JSON.parse(a.exploitsInfoMsgs[0].inningResults);assert.deepEqual(players.find(p=>p.uid===43).showCards,[-1,-1]);assert.deepEqual(players.find(p=>p.uid===42).showCards,[1,2]);
    assert.deepEqual(next.captureHoldemReplay(table,hand,results,42).firstGameList,replay.firstGameList);
    await next.queryHoldemReplay(runtime,account,request,true);assert.equal(reads,1);assert.deepEqual(writes,[180]);
    assert.equal(record.detail.replay.firstGameList[1].operateList[0].cards,undefined);
  }finally{f.close();}
});

test('all real history versions and exported functions are released while retained old views remain usable',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-history.mjs','--history-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_HISTORY_GC/);
});

test('real history helper changes reach engine and handler while failed edits retain connections and resident rooms',()=>{
  const output='cache/hot-history-graph-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs','--loader=collectible','--entry=history','--revisions=26','--clients=4','--sample-every=13','--output='+output],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);const report=JSON.parse(fs.readFileSync(new URL('../../'+output,import.meta.url),'utf8'));
    assert.equal(report.historyChanges,26);assert.equal(report.successfulChanges,26);assert.equal(report.failedCompileAttempts,1);assert.equal(report.requests,112);assert.equal(report.residentRoomChecks,26);assert.equal(report.preservedGameInstances,20);
    assert.equal(report.remainingSessions,0);assert.equal(report.remainingTables,0);assert.deepEqual(report.errors,[]);
  }finally{fs.rmSync(new URL('../../'+output,import.meta.url),{force:true});}
});
