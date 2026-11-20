// Isolated real fixture-source edits and live protocol heartbeats. The test
// never edits production business files, contacts a database or places a bet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import http from 'node:http';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {WebSocket,WebSocketServer} from 'ws';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {importHotModule,hotImportStats} from '../../shared/hot-import.js';
import {installHotSourcePins} from '../../shared/hot-source-pins.js';
import {installHotResolver} from '../../shared/hot-loader.js';
import {createCollectibleEntryLoader,collectibleEntryFiles,collectibleModuleFiles} from '../../shared/hot-entry-factory.js';
import {parse} from 'acorn';

const root=fileURLToPath(new URL('../../',import.meta.url));
const options=new Map();
for(const arg of process.argv.slice(2)){
  const match=/^--(revisions|clients|sample-every|output|loader|entry)=(.+)$/.exec(arg);
  if(!match||options.has(match[1]))throw Error('Expected unique --revisions, --clients, --sample-every, --output, --loader or --entry option');
  options.set(match[1],match[2]);
}
function integer(name,fallback,max){
  const raw=options.get(name)??String(fallback);
  if(!/^\d+$/.test(raw))throw Error('Invalid '+name);
  const value=Number(raw);if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('Invalid '+name);return value;
}
const revisions=integer('revisions',300,5000),clientCount=integer('clients',64,1000),sampleEvery=integer('sample-every',25,1000);
const output=options.get('output')||'cache/hot-source-change-load.json';
const loaderMode=options.get('loader')||'native';
if(!['native','entries','collectible'].includes(loaderMode))throw Error('Invalid loader');
const entryMode=options.get('entry')||'fixture';
if(!['fixture','handler','codec','catalog','class','engine','helper','history'].includes(entryMode))throw Error('Invalid entry');
if(!/^cache\/[a-zA-Z0-9_-]+\.json$/.test(output))throw Error('Output must be a named JSON report inside cache');
if(typeof global.gc!=='function')throw Error('Run this isolated test with node --expose-gc');

installHotSourcePins();
const temporary=fs.mkdtempSync(path.join(root,'cache','hot-source-change-load-'));
const revisionFile=path.join(temporary,'revision.js'),entry=path.join(temporary,'entry.js');
const catalogFile=path.join(temporary,'catalog.js'),classIndexFile=path.join(temporary,'holdem-index.js');
const classFile=path.join(temporary,'holdem-class.js'),engineFile=path.join(temporary,'holdem-engine.js');
const resolver=installHotResolver();
const collectible=createCollectibleEntryLoader({entries:loaderMode==='entries'
  ?[...collectibleEntryFiles,entry]:[...collectibleModuleFiles,entry,revisionFile,...(['helper','history'].includes(entryMode)?[catalogFile,classIndexFile,classFile,engineFile]:entryMode==='engine'?[catalogFile,classIndexFile,classFile]:entryMode==='class'?[catalogFile,classIndexFile]:[])],resolver});
function loadEntry(location,token){
  if(loaderMode==='native')return importHotModule(location,token);
  const url=new URL(location);url.searchParams.set('v',token);url.searchParams.set('link','2');url.searchParams.set('_hot_source','1');
  return collectible.load(resolver.resolve(url.href,{parentURL:import.meta.url},value=>({url:value})).url);
}
const registry=createRegistry(),errors=[],clients=[],samples=[];
const runtime={env:'dev',hotVersion:'real-source-start',registry,configs:[],findConfig:()=>null,
  wallet:{authoritative:true,run(){throw Error('heartbeat attempted a money transaction');}},
  log:{info(){},warn(){},error:(...args)=>errors.push(args.map(value=>value instanceof Error?value.message:String(value)).join(' '))}};
let handler,oldModule,witness,activeRevision=0,requests=0,successfulChanges=0,failedChanges=0,residentRoomChecks=0,concreteClassChanges=0,engineChanges=0,helperChanges=0,historyChanges=0;
const server=http.createServer(),wss=new WebSocketServer({server});
let nextUid=1;
wss.on('connection',socket=>{
  registry.bind(socket,{userId:nextUid++,agentId:7,authenticated:true,inRoom:false});
  socket.on('message',data=>void Promise.resolve(handler.onMessage(socket,data)).catch(error=>errors.push(error.message)));
  socket.on('close',()=>registry.drop(socket));
  socket.on('error',error=>errors.push(error.message));
});
const loop=monitorEventLoopDelay({resolution:10});
const ping=encodeFrame(1200);
function sample(revision){
  global.gc();const memory=process.memoryUsage();
  const row={revision,heapBytes:memory.heapUsed,rssBytes:memory.rss,externalBytes:memory.external,
    sessions:registry.sessions.size,connections:wss.clients.size,requests,imports:hotImportStats(),factories:collectible.stats()};
  samples.push(row);console.log('SOURCE_SAMPLE',JSON.stringify(row));return row;
}
async function beat(){
  await Promise.all(clients.map(client=>new Promise((resolve,reject)=>{
    const done=(error,data)=>{clearTimeout(timer);client.off('message',message);client.off('error',failed);if(error)reject(error);else{try{const frame=decodeFrame(data);assert.equal(frame.msgid,1200);requests++;resolve();}catch(error){reject(error);}}};
    const message=data=>done(null,data),failed=error=>done(error);
    const timer=setTimeout(()=>done(Error('heartbeat deadline exceeded')),5000);
    client.once('message',message);client.once('error',failed);client.send(ping);
  })));
}
async function connect(){
  const socket=new WebSocket('ws://127.0.0.1:'+server.address().port);clients.push(socket);
  await new Promise((resolve,reject)=>{
    const complete=error=>{clearTimeout(timer);socket.off('open',opened);socket.off('error',failed);if(error){socket.terminate();reject(error);}else resolve();};
    const opened=()=>complete(),failed=error=>complete(error);
    const timer=setTimeout(()=>complete(Error('client connection deadline exceeded')),10000);
    socket.once('open',opened);socket.once('error',failed);
  });
  socket.on('error',error=>errors.push(error.message));
}
let started;
try{
  function relocate(source,map){
    const edits=[];
    function visit(node){
      if(node.type==='Literal'&&typeof node.value==='string'&&/^\.{1,2}\/.*\.js$/.test(node.value))edits.push({start:node.start,end:node.end,text:JSON.stringify(map(node.value))});
      for(const value of Object.values(node)){
        if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
        else if(value?.type)visit(value);
      }
    }
    visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));
    for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
    return source;
  }
  let dependencySource=entryMode==='codec'?fs.readFileSync(new URL('../../game-server/src/codec.js',import.meta.url),'utf8')+'\n':'';
  const relativeModule=(specifier,original)=>{
    const relative=path.relative(temporary,fileURLToPath(new URL(specifier,original))).split(path.sep).join('/');
    return relative.startsWith('.')?relative:'./'+relative;
  };
  if(entryMode==='catalog'){
    const original=new URL('../../game-server/src/games/catalog.js',import.meta.url);
    dependencySource=relocate(fs.readFileSync(original,'utf8'),specifier=>relativeModule(specifier,original))+'\n';
  }
  if(['class','engine','helper','history'].includes(entryMode)){
    const originalClass=new URL('../../game-server/src/games/holdem/HoldemGame.js',import.meta.url);
    if(entryMode==='class')dependencySource=relocate(fs.readFileSync(originalClass,'utf8'),specifier=>relativeModule(specifier,originalClass))+'\n';
    else if(entryMode==='engine') {
      const originalEngine=new URL('../../game-server/src/games/holdem/engine.js',import.meta.url);
      dependencySource=relocate(fs.readFileSync(originalEngine,'utf8'),specifier=>relativeModule(specifier,originalEngine))+'\n';
      fs.writeFileSync(classFile,relocate(fs.readFileSync(originalClass,'utf8'),specifier=>specifier==='./engine.js'?'./revision.js':relativeModule(specifier,originalClass)));
    }else{
      const dependency=entryMode==='history'?'history-response.js':'cards.js',originalHelper=new URL('../../game-server/src/games/holdem/'+dependency,import.meta.url),originalEngine=new URL('../../game-server/src/games/holdem/engine.js',import.meta.url);
      dependencySource=fs.readFileSync(originalHelper,'utf8')+'\n';
      fs.writeFileSync(engineFile,relocate(fs.readFileSync(originalEngine,'utf8'),specifier=>specifier==='./'+dependency?'./revision.js':relativeModule(specifier,originalEngine))
        +'\nconst hotTestOriginalConf=texasConf;texasConf=function(table){return {...hotTestOriginalConf(table),'
        +(entryMode==='history'?'hotHistoryRevision:emptyHistoryPayload(table).hotHistoryRevision':'hotHelperRevision:cardName(0)')+'};};');
      fs.writeFileSync(classFile,relocate(fs.readFileSync(originalClass,'utf8'),specifier=>specifier==='./engine.js'?'./holdem-engine.js':relativeModule(specifier,originalClass)));
    }
    const originalIndex=new URL('../../game-server/src/games/holdem/index.js',import.meta.url);
    fs.writeFileSync(classIndexFile,relocate(fs.readFileSync(originalIndex,'utf8'),specifier=>specifier==='./HoldemGame.js'?(entryMode==='class'?'./revision.js':'./holdem-class.js'):relativeModule(specifier,originalIndex)));
    const originalCatalog=new URL('../../game-server/src/games/catalog.js',import.meta.url);
    fs.writeFileSync(catalogFile,relocate(fs.readFileSync(originalCatalog,'utf8'),specifier=>specifier==='./holdem/index.js'?'./holdem-index.js':relativeModule(specifier,originalCatalog)));
  }
  const writeRevision=value=>fs.writeFileSync(revisionFile,dependencySource+'export const revision='+value+';'
    +(entryMode==='class'?'HoldemGame.prototype.hotReloadRevision=function(){return '+value+';};':'')
    +(entryMode==='engine'?'const hotTestOriginalConf=texasConf;texasConf=function(table){return {...hotTestOriginalConf(table),hotEngineRevision:'+value+'};};':'')
    +(entryMode==='helper'?'const hotTestOriginalName=cardName;cardName=id=>hotTestOriginalName(id)+"#'+value+'";':'')
    +(entryMode==='history'?'const hotTestOriginalHistory=emptyHistoryPayload;emptyHistoryPayload=function(table,request){return {...hotTestOriginalHistory(table,request),hotHistoryRevision:'+value+'};};':''));
  writeRevision(0);
  let handlerSource="import {rel} from '../../shared/hot-import.js';\nexport {createHandler} from '../../game-server/src/create-handler.js';";
  if(['handler','codec','catalog','class','engine','helper','history'].includes(entryMode)){
    // Copy the real entry, relocating dependency literals only. Actual service
    // files stay untouched while each revision recompiles the whole handler.
    const original=new URL('../../game-server/src/create-handler.js',import.meta.url);
    handlerSource=relocate(fs.readFileSync(original,'utf8'),specifier=>{
      if(['class','engine','helper','history'].includes(entryMode)){
        if(specifier==='./games/catalog.js')return './catalog.js';
        if(entryMode==='engine'&&specifier==='./games/holdem/engine.js')return './revision.js';
        if(['helper','history'].includes(entryMode)&&specifier==='./games/holdem/engine.js')return './holdem-engine.js';
        return relativeModule(specifier,original);
      }
      const redirected=entryMode==='codec'&&specifier==='./codec.js'||entryMode==='catalog'&&specifier==='./games/catalog.js';
      return (redirected?pathToFileURL(revisionFile):new URL(specifier,original)).href;
    });
  }
  fs.writeFileSync(entry,[handlerSource,
    "export const revision=(await rel(import.meta.url,'./revision.js','initial')).revision;",
    "export const late=()=>rel(import.meta.url,'./revision.js','old-request').then(module=>module.revision);",
  ].join('\n'));
  const entryURL=pathToFileURL(entry).href;
  oldModule=await loadEntry(entryURL,'source-revision-0');handler=await oldModule.createHandler(runtime);
  assert.equal(oldModule.revision,0);
  if(['catalog','class','engine','helper','history'].includes(entryMode)){
    const game=handler.games.byRoomType.get(19),table=game.createTable(700001,19,{small_blind:10,big_blind:20,carry_min:100});
    const member={uid:90001,pos:0,point:450,totalBet:50,bot:false};
    table.members.push(member);table.currentInning=7;table.phase='playing';table.hand={revisionWitness:true,pot:50};
    registry.setTable(table.roomId,table,7,game.id);
    witness={table,member,hand:table.hand,createdAt:table.createdAt,expiresAt:table.expiresAt,games:handler.games.list.slice(),previousGame:game};
    if(entryMode==='class')assert.equal(game.hotReloadRevision(),0);
    if(entryMode==='engine')assert.equal(game.buildConf(table).hotEngineRevision,0);
    if(entryMode==='helper')assert.equal(game.buildConf(table).hotHelperRevision,'DIAMOND_A#0');
    if(entryMode==='history')assert.equal(game.buildConf(table).hotHistoryRevision,0);
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  for(let at=0;at<clientCount;at+=32)await Promise.all(Array.from({length:Math.min(32,clientCount-at)},connect));
  await beat();loop.enable();started=performance.now();sample(0);
  for(let revision=1;revision<=revisions;revision++){
    // Every twenty fifth attempt fails compilation; the last working handler
    // and all existing sockets must continue to answer heartbeats.
    if(revision%25===0){
      writeRevision('');
      let failure;
      try{await loadEntry(entryURL,'broken-source-'+revision);}catch(error){failure=error;}
      assert.ok(failure instanceof SyntaxError,'invalid source unexpectedly replaced the live handler');failedChanges++;
      await beat();assert.equal(await oldModule.late(),0);
    }
    writeRevision(revision);
    const next=await loadEntry(entryURL,'source-revision-'+revision);
    assert.equal(next.revision,revision,'new source version did not take effect');
    const originalLate=oldModule.late();
    runtime.hotVersion='source-revision-'+revision;
    handler=await next.createHandler(runtime);activeRevision=revision;successfulChanges++;
    if(witness){
      assert.equal(handler.games.list.length,witness.games.length);
      for(const game of witness.games){
        const current=handler.games.list.find(candidate=>candidate.id===game.id);
        if(['class','engine','helper','history'].includes(entryMode)&&game.id==='holdem'){
          assert.notEqual(current,witness.previousGame);assert.notEqual(current.constructor,witness.previousGame.constructor);
          if(entryMode==='class'){
            assert.equal(current.hotReloadRevision(),revision);assert.equal(game.hotReloadRevision(),0);concreteClassChanges++;
          }else if(entryMode==='engine'){
            assert.equal(current.buildConf(witness.table).hotEngineRevision,revision);assert.equal(game.buildConf(witness.table).hotEngineRevision,0);engineChanges++;
          }else if(entryMode==='helper'){
            assert.equal(current.buildConf(witness.table).hotHelperRevision,'DIAMOND_A#'+revision);assert.equal(game.buildConf(witness.table).hotHelperRevision,'DIAMOND_A#0');helperChanges++;
          }else{
            assert.equal(current.buildConf(witness.table).hotHistoryRevision,revision);assert.equal(game.buildConf(witness.table).hotHistoryRevision,0);historyChanges++;
          }
          witness.previousGame=current;
        }else assert.equal(current,game,'unchanged default game instance was recreated');
      }
      assert.equal(registry.getTable(700001,7,'holdem'),witness.table);
      assert.equal(witness.table.members[0],witness.member);assert.equal(witness.member.point,450);assert.equal(witness.member.totalBet,50);
      assert.equal(witness.table.hand,witness.hand);assert.equal(witness.hand.pot,50);assert.equal(witness.table.currentInning,7);
      assert.equal(witness.table.createdAt,witness.createdAt);assert.equal(witness.table.expiresAt,witness.expiresAt);residentRoomChecks++;
    }
    assert.equal(await originalLate,0,'old caller switched to the new dependency');
    assert.equal(await next.late(),revision);
    assert.equal(await loadEntry(entryURL,'unchanged-source-'+revision),next,'unchanged source created a new module namespace');
    await beat();
    assert.equal(registry.sessions.size,clientCount);assert.equal(wss.clients.size,clientCount);
    assert.ok(clients.every(socket=>socket.readyState===WebSocket.OPEN));
    if(revision%sampleEvery===0||revision===revisions)sample(revision);
    await new Promise(resolve=>setImmediate(resolve));
  }
}catch(error){errors.push(error.stack||error.message);process.exitCode=1;
}finally{
  loop.disable();
  const closed=[...wss.clients].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
  for(const socket of clients)socket.terminate();for(const socket of wss.clients)socket.terminate();
  await Promise.all(closed);
  await new Promise(resolve=>wss.close(resolve));
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  if(witness)registry.removeTable(700001,7,'holdem');
  const preservedGameInstances=witness?witness.games.length-(['class','engine','helper','history'].includes(entryMode)?1:0):0;witness=null;
  await new Promise(resolve=>setImmediate(resolve));handler=null;oldModule=null;global.gc();
  if(registry.sessions.size)errors.push('resident sessions were not released on close');
  const first=samples[0],last=samples.at(-1);
  const result={scope:'isolated real fixture edits, repeated game-handler replacement and live protocol heartbeats; no money operations',
    loader:loaderMode,entry:entryMode,node:process.version,revisionsRequested:revisions,successfulChanges,failedCompileAttempts:failedChanges,activeRevision,
    clients:clientCount,requests,durationSeconds:started?(performance.now()-started)/1000:0,
    heapGrowthBytes:first&&last?last.heapBytes-first.heapBytes:null,heapBytesPerRevision:first&&last&&last.revision?(last.heapBytes-first.heapBytes)/last.revision:null,
    samples,afterCloseHeapBytes:process.memoryUsage().heapUsed,remainingSessions:registry.sessions.size,
    residentRoomChecks,preservedGameInstances,concreteClassChanges,engineChanges,helperChanges,historyChanges,remainingTables:registry.tables.size,
    eventLoopP99Ms:loop.percentile(99)/1e6,eventLoopMaxMs:loop.max/1e6,errors,
    limitations:'Short isolated run. Heap samples include Node ESM caches; no claim of complete module unloading or multi-day production acceptance.'};
  fs.writeFileSync(path.join(root,output),JSON.stringify(result,null,2)+'\n');
  console.log('SOURCE_RESULT',JSON.stringify({...result,samples:result.samples.length}));
  fs.rmSync(temporary,{recursive:true,force:true});
  if(errors.length||successfulChanges!==revisions)process.exitCode=1;
}
