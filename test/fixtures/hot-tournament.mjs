import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {historyFixture} from './hot-history.mjs';
import {collectibleTournamentFiles} from '../../shared/hot-entry-factory.js';
import {createRegistry} from '../../game-server/src/registry.js';

export function tournamentFixture(){return historyFixture(collectibleTournamentFiles);}

export function tournamentRuntime(){
  const events=[],secret='isolated-hot-tournament';let at=Date.now();
  const runtime={env:'prod',hotVersion:'fixture',config:{match_control_secret:secret,tournament_cleanup_delay_ms:0},clock:()=>at,registry:createRegistry(),rpc:{lobby:{getMatch:async()=>({agent_id:7,state:2})}},log:{error(){}}};
  const game={id:'holdem',config:{maxPeople:9},createTable(roomId,roomType,cfg){return {roomId,roomType,cfg,gameId:'holdem',kind:'normal',members:[],observers:[],phase:'idle',currentInning:0,startAt:0,userCenterReportsReady:()=>true};},queueStart(table){table.phase='starting';table.startAt=0;},roomInfo:table=>({roomId:table.roomId}),watch(){}};
  const io=table=>({broadcast:(id,data)=>events.push({roomId:table.roomId,id,data}),send:(ws,id,data)=>events.push({ws,id,data}),sendUser:(uid,id,data)=>events.push({uid,id,data}),forEachPlayer(){}});
  const start=()=>({action:'start',agentId:7,matchId:99,config:{initPoint:100,startedAt:at,lateSeconds:120,rebuyLimit:1,levels:[{min:5,max:10,bet:0,interval:60},{min:10,max:20,bet:0,interval:0}]},players:[{uid:42,name:'one',point:100},{uid:43,name:'two',point:100}]});
  return {runtime,game,io,events,secret,start,get at(){return at;},advance(ms){at+=ms;},close(){clearInterval(runtime.tournamentIdempotency?.timer);}};
}

if(process.argv.includes('--tournament-gc')){
  assert.equal(typeof global.gc,'function');const count=Number(process.argv.find(arg=>arg.startsWith('--revisions='))?.slice('--revisions='.length)||24);assert.ok(Number.isSafeInteger(count)&&count>=24&&count<=2000);
  const f=tournamentFixture(),x=tournamentRuntime(),first=new Map(),weak=[],samples=[],started=performance.now();let match,clock,table,timer;
  try{
    for(let revision=0;revision<count;revision++){
      f.write(revision);
      for(let i=0;i<f.sources.length;i++){
        const module=await f.load(i,revision);assert.equal(module.hotTestRevision,revision);if(revision===0)first.set(i,module);const refs=[new WeakRef(module)];
        for(const [name,value]of Object.entries(module))if(value!==first.get(i)[name]&&value&&(typeof value==='function'||typeof value==='object'))refs.push(new WeakRef(value));
        if(module.createTournamentControl){
          const control=await module.createTournamentControl(x.runtime,()=>x.game,x.io),{signControl}=await f.load('shared/tournament-control.js',revision);let reply;
          const payload=revision===0?x.start():{action:'status',agentId:7,matchId:99};await control.handle({readyState:1,send:raw=>{reply=JSON.parse(raw);}},signControl(x.secret,payload));assert.equal(reply.code,200);
          match??=x.runtime.tournamentRooms.matches.get('7:99');clock??=match.clock;table??=match.tables[0];timer??=x.runtime.tournamentIdempotency.timer;
          assert.equal(x.runtime.tournamentRooms.matches.get('7:99'),match);assert.equal(match.clock,clock);assert.equal(match.tables[0],table);assert.equal(x.runtime.tournamentIdempotency.timer,timer);assert.equal(table.members[0].point,100);
          if(revision>0)refs.push(new WeakRef(control),new WeakRef(control.handle));
        }
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
      if(revision%25===0||revision===count-1){global.gc();samples.push({revision,heapBytes:process.memoryUsage().heapUsed});}
    }
    for(let i=0;i<12;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(weak.filter(item=>item.revision>0&&item.revision<count-1).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released tournament code retained');
    const stats=f.loader.stats();assert.equal(stats.activeEntries,8);assert.equal(stats.compiledEntries,8*count);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    console.log('PASS_REAL_TOURNAMENT_GC',JSON.stringify({modules:8,versions:count,stats,samples,heapGrowthBytes:samples.at(-1).heapBytes-samples[0].heapBytes,durationSeconds:(performance.now()-started)/1000,sameClock:true,sameTable:true,sameTimer:true,limitations:'Isolated production controller and storage lookup substitute; no cash operations, remote storage or real match service.'}));
  }finally{x.close();f.close();}
}
