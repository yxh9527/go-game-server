import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {queryHistory}=await importHotModule(new URL("../../shared/history-query.js",import.meta.url).href,"history-selected-test/shared/history-query.test.js");
const query={kind:'hands',userId:42,agentId:7,currency:'CNY',roomType:24,roomId:700001,page:1,size:100,startTime:1000,endTime:2000,sortDesc:true};

test('canonical account history cache lives three minutes without hit renewal and coalesces pending requests',async()=>{
  let now=0,reads=0;const cache=new Map(),writes=[];
  const runtime={gateway:{getUserCenter:async()=>{reads++;await new Promise(r=>setImmediate(r));return {records:[]};}},bus:{getCache:async key=>{const entry=cache.get(key);return entry&&now<entry.expires?entry.value:null;},setCache:async(key,value,ttl)=>{writes.push(ttl);cache.set(key,{value,expires:now+ttl*1000});}}};
  await Promise.all(Array.from({length:20},()=>queryHistory(runtime,query)));assert.equal(reads,1);assert.deepEqual(writes,[180]);
  now=179999;await queryHistory(runtime,query);assert.equal(reads,1);assert.deepEqual(writes,[180]);
  now=180000;await queryHistory(runtime,query);assert.equal(reads,2);assert.equal(runtime.historyQueries.pending.size,0);
  for(const patch of [{userId:43},{agentId:8},{currency:'USD'},{roomId:700002},{roomType:27},{page:2}])await queryHistory(runtime,{...query,...patch});
  assert.equal(reads,8);assert.equal(cache.size,7);
});

test('relative history windows do not produce a new key every millisecond; query-only fields cannot fragment keys',async()=>{
  let reads=0;const cache=new Map();const runtime={gateway:{getUserCenter:async()=>{reads++;return {records:[]};}},bus:{getCache:async key=>cache.get(key),setCache:async(key,v)=>cache.set(key,v)}};
  await queryHistory(runtime,query,{relativeWindowMs:1000});
  await queryHistory(runtime,{...query,startTime:1010,endTime:2010,attackerField:'random'},{relativeWindowMs:1000});
  assert.equal(reads,1);assert.equal(cache.size,1);
});

test('failed or malformed source is not cached, Redis outages preserve ES result, and errors release pending references',async()=>{
  let writes=0;
  const runtime={gateway:{getUserCenter:async()=>{throw Error('ES unavailable');}},bus:{getCache:async()=>null,setCache:async()=>{writes++;}}};
  await assert.rejects(()=>queryHistory(runtime,query),/ES unavailable/);assert.equal(writes,0);assert.equal(runtime.historyQueries.pending.size,0);
  runtime.gateway.getUserCenter=async()=>({error:'bad source'});await assert.rejects(()=>queryHistory(runtime,query),/无效/);assert.equal(writes,0);
  runtime.gateway.getUserCenter=async()=>({records:[]});runtime.bus={getCache:async()=>{throw Error('Redis unavailable');},setCache:async()=>{throw Error('Redis unavailable');}};
  assert.deepEqual(await queryHistory(runtime,query),{records:[]});
});

test('distinct concurrent queries have an account budget and release it after completion',async()=>{
  const resolvers=[];const runtime={gateway:{getUserCenter:()=>new Promise(resolve=>resolvers.push(resolve))}};
  const pending=Array.from({length:4},(_,i)=>queryHistory(runtime,{...query,page:i+1}));
  await assert.rejects(()=>queryHistory(runtime,{...query,page:5}),/繁忙/);
  const same=queryHistory(runtime,query);await new Promise(resolve=>setImmediate(resolve));assert.equal(resolvers.length,4);
  for(const resolve of resolvers)resolve({records:[]});await Promise.all([...pending,same]);assert.equal(runtime.historyQueries.owners.size,0);
});

test('numeric strings, explicit defaults and parameter order resolve to one canonical key and normalized RPC request',async()=>{
  const cache=new Map(),requests=[],writes=[];
  const runtime={gateway:{getUserCenter:async input=>{requests.push(input);return {records:[]};}},bus:{getCache:async k=>cache.get(k),setCache:async(k,v,ttl)=>{cache.set(k,v);writes.push(ttl);}}};
  const strings=Object.fromEntries(Object.entries(query).map(([key,value])=>[key,typeof value==='number'||typeof value==='boolean'?String(value):value]));
  await queryHistory(runtime,strings);
  await queryHistory(runtime,{...query,inning:0,inningFrom:0,inningTo:0,privateRoom:false,irrelevant:'random'});
  await queryHistory(runtime,Object.fromEntries(Object.entries(query).reverse()));
  assert.equal(requests.length,1);assert.deepEqual(writes,[180]);assert.equal(requests[0].userId,42);assert.equal(requests[0].sortDesc,true);assert.equal(requests[0].inning,0);
});

test('invalid scope, dates, booleans and paging are rejected before either cache or source access',async()=>{
  let accesses=0;const runtime={bus:{getCache:async()=>{accesses++;}},gateway:{getUserCenter:async()=>{accesses++;return {records:[]};}}};
  for(const patch of [{userId:0},{agentId:-1},{agentId:undefined},{currency:'CNY\n'},{userId:[]},{roomId:true},{page:1.5},{page:'1e1'},
    {size:101},{page:1000},{endTime:999},{startTime:0},{startTime:1,endTime:31*86400000+2},{sortDesc:'false-ish'},{inningFrom:4,inningTo:3},{kind:'arbitrary'}])
    await assert.rejects(()=>queryHistory(runtime,{...query,...patch}),error=>error.status===400);
  await assert.rejects(()=>queryHistory(runtime,query,{relativeWindowMs:500}),error=>error.status===400);
  await assert.rejects(()=>queryHistory(runtime,query,{relativeWindowMs:1000,rollingEnd:true}),error=>error.status===400);
  assert.equal(accesses,0);assert.equal(runtime.historyQueries,undefined);
});

test('malformed cached responses are replaced from the source and failure-shaped fund or match results are never cached',async()=>{
  let reads=0,writes=0,cached='{}';
  const runtime={bus:{getCache:async()=>cached,setCache:async(_k,v)=>{writes++;cached=v;}},gateway:{getUserCenter:async()=>{reads++;return {records:[]};}}};
  for(const value of [{},[],{records:[],error:'offline'},{records:[],code:3},{records:[],total:-1},{records:null}]){
    cached=JSON.stringify(value);await queryHistory(runtime,query);
  }
  assert.equal(reads,6);assert.equal(writes,6);
  const before=writes;
  for(const kind of ['funds','tickets','matches','match']){
    cached=null;runtime.gateway.getUserCenter=async()=>({error:'source offline'});
    await assert.rejects(()=>queryHistory(runtime,{...query,kind}),/无效/);
  }
  assert.equal(writes,before);assert.equal(runtime.historyQueries.pending.size,0);
  for(const [kind,value]of [['funds',{logs:[],total:0}],['tickets',{logs:[],total:0}],['matches',{matches:[],totalScore:0}],['match',{match:null}]]){
    cached=null;runtime.gateway.getUserCenter=async()=>value;assert.deepEqual(await queryHistory(runtime,{...query,kind}),value);
  }
});

test('full replay room option is bounded to a replay identity and distinct from an ordinary page',async()=>{
  const cache=new Map(),calls=[];const runtime={gateway:{getUserCenter:async input=>{calls.push(input);return {records:[]};}},bus:{getCache:async key=>cache.get(key),setCache:async(key,value)=>cache.set(key,value)}};
  const replay={...query,kind:'replay',roomType:19};
  await queryHistory(runtime,replay);await queryHistory(runtime,{...replay,allInnings:'true'});
  assert.equal(calls.length,2);assert.equal(calls[0].allInnings,undefined);assert.equal(calls[1].allInnings,true);assert.equal(cache.size,2);
  for(const patch of [{kind:'hands'},{roomId:0},{roomType:25},{page:2}])await assert.rejects(()=>queryHistory(runtime,{...replay,...patch,allInnings:true}),error=>error.status===400);
});
