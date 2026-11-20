import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {ticketFixture} from '../fixtures/hot-tickets.mjs';
import {collectibleTicketFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';
import config from '../../game-server/src/games/ggl-mjhl/config.js';

function fixture(){
  const calls=[],routes={resolve:()=>({number:91061})},paid=new Map();
  const common={async scratch(operation,input){calls.push({operation,input:structuredClone(input)});
    if(operation==='state')return {code:0,pendingTickets:[],denominations:config.denominations,winMultipliers:config.winMultipliers};
    if(operation==='issue'){if(!paid.has(input.requestId))paid.set(input.requestId,input.candidates[0].tickets[0]);return {code:0,newTickets:[{serialFull:input.candidates[0].tickets[0].serialFull,faceValue:input.faceValue,gglKind:'GGL1'}]};}
    throw Error('unexpected '+operation);
  }};
  const ctx={table:{roomId:61010026,gameRoomId:62010026,roomType:61,cfg:{game_type:1004,finance_level:1},config},session:{agentId:7,userId:42,currency:'CNY',wallet:1000},runtime:{wallet:{guardExternalMoney(){},async load(){}}}};
  return {calls,routes,paid,common,ctx};
}

test('ticket factories are selected without moving inventory, money or original queue ownership',()=>{
  assert.equal(collectibleTicketFiles.length,3);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleTicketFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../game-server/src/registry.js','../../shared/session-revocation-listener.js','../../shared/rpc/index.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('real old and new ticket modules share one queue and preserve pending request snapshots across source replacement',async()=>{
  const f=ticketFixture(),x=fixture();try{
    f.write(0);const old=await f.load('ggl-core/rpc-tickets.js',0),a=old.createRpcScratchTickets(x.common,{routes:x.routes}),invoke=x.common.scratch;let release,active=0,max=0;
    const gate=new Promise(resolve=>{release=resolve;});let first=true;
    x.common.scratch=async(...args)=>{active++;max=Math.max(max,active);try{if(first){first=false;await gate;}return await invoke(...args);}finally{active--;}};
    const body={faceValue:100,purchaseMode:'RANDOM_SINGLE',serialFulls:['original-serial']},purchase=a.purchase(x.ctx,body);
    await new Promise(resolve=>setImmediate(resolve));body.faceValue=200;body.serialFulls[0]='changed-serial';
    const owner=x.common[Symbol.for('gogame.scratch.rpc.tasks.v1')],tasks=owner.tasks;
    f.write(1);const current=await f.load('ggl-core/rpc-tickets.js',1),b=current.createRpcScratchTickets(x.common,{routes:x.routes});assert.notEqual(old.createRpcScratchTickets,current.createRpcScratchTickets);
    const queued=Array.from({length:7},()=>b.state(x.ctx));assert.equal(owner.pendingTotal,8);assert.equal(owner.tasks,tasks);
    await assert.rejects(b.state(x.ctx),error=>error.code===100085);assert.equal(x.calls.length,0);
    release();const result=await purchase;await Promise.all(queued);assert.equal(result.code,0);assert.equal(max,1);assert.equal(x.paid.size,1);
    const issued=x.calls.find(call=>call.operation==='issue').input;assert.equal(issued.faceValue,100);assert.deepEqual(issued.refs,['original-serial']);assert.equal(issued.candidates[0].tickets[0].serialFull,'original-serial');
    assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);assert.equal((await a.state(x.ctx)).code,0);assert.equal((await b.state(x.ctx)).code,0);
  }finally{f.close();}
});

test('lost purchase acknowledgement retries the identical original candidate after source replacement without a second purchase',async()=>{
  const f=ticketFixture(),x=fixture();try{
    f.write(0);const old=await f.load('ggl-core/rpc-tickets.js',0),a=old.createRpcScratchTickets(x.common,{routes:x.routes}),invoke=x.common.scratch;let release;
    const gate=new Promise(resolve=>{release=resolve;});let lose=true;
    x.common.scratch=async(...args)=>{const value=await invoke(...args);if(args[0]==='issue'&&lose){lose=false;await gate;throw Object.assign(Error('lost ack'),{code:4,uncertain:true});}return value;};
    const purchase=a.purchase(x.ctx,{faceValue:100,purchaseMode:'RANDOM_SINGLE',serialFulls:['paid-original']});
    for(let i=0;i<20&&!x.paid.size;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(x.paid.size,1);
    f.write(1);const next=await f.load('ggl-core/rpc-tickets.js',1),b=next.createRpcScratchTickets(x.common,{routes:x.routes}),state=b.state(x.ctx);
    release();assert.equal((await purchase).code,0);await state;
    const attempts=x.calls.filter(call=>call.operation==='issue');assert.equal(attempts.length,2);assert.deepEqual(attempts[0].input,attempts[1].input);assert.equal(x.paid.size,1);
    const owner=x.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.tasks.size,0);
  }finally{f.close();}
});

test('new and old plan factories preserve exact original reel versions and reject unconfirmed control selections',async()=>{
  const f=ticketFixture();try{
    f.write(0);const old=await f.load('ggl-core/control-plan.js',0),profileOld=await f.load('ggl-core/reel-profile.js',0);
    const profile=profileOld.scratchReelProfile([0,7,13,23,31]);const before=old.scratchCandidates(profile,100,{rng:()=>0n});
    f.write(1);const next=await f.load('ggl-core/control-plan.js',1),profileNext=await f.load('ggl-core/reel-profile.js',1);
    const after=next.scratchCandidates(profileNext.scratchReelProfile([0,7,13,23,31]),100,{rng:()=>0n});assert.deepEqual(after,before);assert.ok(before.every(candidate=>Object.isFrozen(candidate.huMask)));assert.equal(before[0].reelVersion,after[0].reelVersion);
    const settings={route:{number:91061},agentId:7,userId:42,currency:'CNY',level:1,profile,faceValue:100};
    await assert.rejects(next.selectScratchPlan({finance:async()=>({code:0,selectedCandidateId:'foreign',decisionId:'bad'})},settings),/valid generated/);
    assert.equal(old.hotTestRevision,0);assert.equal(next.hotTestRevision,1);
  }finally{f.close();}
});

test('released ticket adapters, candidate plans and compiled sampler graphs can be collected with an empty resident queue',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-tickets.mjs','--ticket-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_TICKET_GC/);
});
