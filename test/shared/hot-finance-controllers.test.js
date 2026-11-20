import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {financeControllerFixture} from '../fixtures/hot-finance-controllers.mjs';
import {seatFinanceAuthority} from '../fixtures/seat-finance-authority.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {createGameRouteIndex} from '../../shared/rpc/game-routes.js';
import {env,loadEnv} from '../../shared/rpc/env.js';
import {collectibleFinanceControllerFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const routes=number=>createGameRouteIndex([{gameType:1000,roomType:50,number,symbol:'pool-'+number,state:1,isFrozen:0}]);

async function walletFixture(f){
  f.write(0);const {createAuthoritativeWallet}=await f.load('wallet/authoritative.js',0);
  const authority=seatFinanceAuthority();authority.add(42,1000);
  const session={agentId:7,userId:42,currency:'CNY',authenticated:true},member={uid:42,point:0};
  const table={agentId:7,gameId:'holdem',roomId:7,roomType:19,kind:'normal',members:[member],observers:[],phase:'idle'},registry=createRegistry();
  registry.bind({},session);registry.setTable(7,table,7,'holdem');
  const wallet=createAuthoritativeWallet({common:authority.common});await wallet.load(session);
  return {authority,session,member,table,wallet,runtime:{registry,wallet,log:{error(){}}}};
}

test('three financial controllers use collectible factories while RPC, registry and carry ownership remain resident',async()=>{
  assert.equal(collectibleFinanceControllerFiles.length,3);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();
  for(const file of collectibleFinanceControllerFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/rpc/index.js','../../game-server/src/registry.js','../../shared/session-revocation-listener.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
  const f=financeControllerFixture();try{f.write(0);const first=await f.load('wallet/authoritative.js',0);assert.equal(await f.load('wallet/authoritative.js',0),first);}finally{f.close();}
});

test('wallet replacement preserves the pending transaction queue, carry token and original common owner',async()=>{
  const f=financeControllerFixture(),gate=deferred(),started=deferred();
  try{
    const w=await walletFixture(f),apply=w.authority.common.cashApply,order=[];let first=true,secondStarted=false;
    w.authority.common.cashApply=async request=>{const reply=await apply(request);if(first){first=false;started.resolve();await gate.promise;}return reply;};
    const pending=w.wallet.run(()=>{w.wallet.reserveCarry(w.session,w.member,w.table,500);w.wallet.deliver(()=>order.push('first'));},w.runtime);
    await started.promise;const token=w.authority.account(42).carry.token;
    f.write(1);const {createAuthoritativeWallet}=await f.load('wallet/authoritative.js',1),next=createAuthoritativeWallet({common:w.authority.common});
    Object.defineProperties(w.runtime.wallet,Object.getOwnPropertyDescriptors(next));
    const queued=next.run(()=>{secondStarted=true;assert.equal(w.wallet.managed(),true);next.reserveCarry(w.session,w.member,w.table,100);next.deliver(()=>order.push('second'));},w.runtime);
    await turn();assert.equal(secondStarted,false);assert.deepEqual(order,[]);gate.resolve();await Promise.all([pending,queued]);
    assert.equal(w.member.point,600);assert.equal(w.session.wallet,1000);assert.equal(w.authority.account(42).carry.token,token);assert.equal(w.authority.cashCalls.length,2);assert.deepEqual(order,['first','second']);
    assert.equal(next.managed(),false);assert.equal(w.wallet.managed(),false);
    await next.run(()=>next.releaseCarry(w.session,w.member),w.runtime);assert.equal(w.session.carryAmount,0);assert.equal(w.session.wallet,1000);assert.equal(w.authority.cashCalls.length,3);
  }finally{gate.resolve();f.close();}
});

test('a rejected old wallet transaction rolls back before a replacement controller starts its queued action',async()=>{
  const f=financeControllerFixture(),gate=deferred(),started=deferred();
  try{
    const w=await walletFixture(f),apply=w.authority.common.cashApply;let attempts=0;
    w.authority.common.cashApply=async request=>{if(++attempts===1){started.resolve();await gate.promise;throw Object.assign(Error('original version rejected'),{code:9});}return apply(request);};
    const pending=w.wallet.run(()=>{w.wallet.reserveCarry(w.session,w.member,w.table,500);w.table.phase='unconfirmed';},w.runtime),rejected=assert.rejects(pending,/original version rejected/);
    await started.promise;f.write(1);const {createAuthoritativeWallet}=await f.load('wallet/authoritative.js',1),next=createAuthoritativeWallet({common:w.authority.common});
    const queued=next.run(()=>{assert.equal(w.table.phase,'idle');assert.equal(w.member.point,0);next.reserveCarry(w.session,w.member,w.table,200);},w.runtime);
    gate.resolve();await Promise.all([rejected,queued]);assert.equal(w.member.point,200);assert.equal(w.authority.account(42).carry.amount,200);assert.equal(attempts,2);assert.equal(w.authority.cashCalls.length,1);
  }finally{gate.resolve();f.close();}
});

test('an uncertain original cash acknowledgement remains paused after wallet code replacement',async()=>{
  const f=financeControllerFixture();try{
    const w=await walletFixture(f),apply=w.authority.common.cashApply;
    w.authority.common.cashApply=async request=>{await apply(request);throw Object.assign(Error('lost confirmed cash reply'),{status:504});};
    await assert.rejects(w.wallet.run(()=>w.wallet.reserveCarry(w.session,w.member,w.table,500),w.runtime),/lost confirmed cash reply/);
    f.write(1);const {createAuthoritativeWallet}=await f.load('wallet/authoritative.js',1),next=createAuthoritativeWallet({common:w.authority.common});
    assert.throws(()=>next.guardExternalMoney(w.session),{code:'CASH_CONFIRMATION_REQUIRED'});
    await assert.rejects(next.run(()=>next.reserveCarry(w.session,w.member,w.table,500),w.runtime),{code:'CASH_CONFIRMATION_REQUIRED'});
    assert.equal(w.authority.cashCalls.length,1);assert.equal(w.authority.account(42).carry.amount,500);assert.equal(w.authority.account(42).balance,1000);
  }finally{f.close();}
});

test('replacement round controllers share in-flight wagers, command identity, queue and the original game mapping',async()=>{
  const f=financeControllerFixture(),gate=deferred(),started=deferred();try{
    f.write(0);const old=await f.load('wallet/round-finance.js',0),authority=seatFinanceAuthority();authority.add(42,1000);
    const common=authority.common,finance=common.finance,table={agentId:7,cfg:{game_type:1000,room_type:50,finance_level:1}},round={},session={agentId:7,userId:42,currency:'CNY'},operation={};let first=true;
    common.finance=async(...args)=>{const reply=await finance(...args);if(first&&args[0]==='bet'){first=false;started.resolve();await gate.promise;}return reply;};
    const a=old.createRoundFinance(common,{routes:routes(91050)}),identity=a.identity(table,round),pending=a.bet(table,round,session,[{areaId:1,amount:100}],operation);
    await started.promise;f.write(1);const newer=await f.load('wallet/round-finance.js',1),b=newer.createRoundFinance(common,{routes:routes(92050)});
    assert.deepEqual(b.identity(table,round),identity);assert.equal(b.bet(table,round,session,[{areaId:1,amount:100}],operation),pending);
    const queued=b.bet(table,round,session,[{areaId:2,amount:50}]);await turn();assert.equal(authority.calls.length,1);
    gate.resolve();await Promise.all([pending,queued]);assert.equal(authority.account(42).balance,850);assert.equal(authority.calls.length,2);
    const bets=authority.calls.filter(call=>call.method==='bet');assert.ok(bets.every(call=>call.request.gameId===91050&&call.request.roundId===identity.roundId));assert.notEqual(bets[0].request.items[0].betId,bets[1].request.items[0].betId);
    const results=[{session,payout:200}],outcome={winner:42},settled=b.settle(table,round,results,outcome);await settled;
    assert.equal(a.settle(table,round,results,outcome),settled);assert.equal(authority.account(42).balance,1050);assert.equal(authority.calls.filter(call=>call.method==='settlement').length,1);
    assert.equal(b.identity(table,{}).gameId,92050);
  }finally{gate.resolve();f.close();}
});

test('an unconfirmed round remains blocked across replacement without another wager or query',async()=>{
  const f=financeControllerFixture();try{
    f.write(0);const old=await f.load('wallet/round-finance.js',0),authority=seatFinanceAuthority();authority.add(42,1000);
    const finance=authority.common.finance;authority.common.finance=async(method,...args)=>{if(method==='getRoundFinanceState')throw Object.assign(Error('query unavailable'),{code:14});await finance(method,...args);throw Object.assign(Error('reply lost'),{code:4});};
    const table={agentId:7,cfg:{game_type:1000,room_type:50,finance_level:1}},round={},session={agentId:7,userId:42,currency:'CNY'},operation={},a=old.createRoundFinance(authority.common,{routes:routes(91050)});
    await assert.rejects(a.bet(table,round,session,[{amount:100}],operation),{code:'FINANCE_CONFIRMATION_REQUIRED'});
    f.write(1);const newer=await f.load('wallet/round-finance.js',1),b=newer.createRoundFinance(authority.common,{routes:routes(92050)});
    await assert.rejects(b.bet(table,round,session,[{amount:100}],operation),{code:'FINANCE_CONFIRMATION_REQUIRED'});
    await assert.rejects(b.bet(table,round,session,[{amount:100}]),{code:'FINANCE_CONFIRMATION_REQUIRED'});
    assert.equal(authority.calls.length,1);assert.equal(authority.account(42).balance,900);
  }finally{f.close();}
});

test('replacement controllers join an original pending settlement instead of issuing another payout',async()=>{
  const f=financeControllerFixture(),gate=deferred(),started=deferred();try{
    f.write(0);const old=await f.load('wallet/round-finance.js',0),authority=seatFinanceAuthority();authority.add(42,1000);
    const table={agentId:7,cfg:{game_type:1000,room_type:50,finance_level:1}},round={},session={agentId:7,userId:42,currency:'CNY'},a=old.createRoundFinance(authority.common,{routes:routes(91050)});
    await a.bet(table,round,session,[{amount:100}]);const finance=authority.common.finance;
    authority.common.finance=async(method,...args)=>{const reply=await finance(method,...args);if(method==='settlement'){started.resolve();await gate.promise;}return reply;};
    const results=[{session,payout:200}],outcome={winner:42},pending=a.settle(table,round,results,outcome);await started.promise;
    f.write(1);const newer=await f.load('wallet/round-finance.js',1),b=newer.createRoundFinance(authority.common,{routes:routes(92050)});
    assert.equal(b.settle(table,round,results,outcome),pending);assert.throws(()=>b.settle(table,round,[{session,payout:300}],outcome),/changed/);
    assert.equal(authority.calls.filter(call=>call.method==='settlement').length,1);gate.resolve();await pending;
    assert.equal(authority.account(42).balance,1100);assert.equal(b.settle(table,round,results,outcome),pending);assert.equal(authority.calls.filter(call=>call.method==='settlement').length,1);
  }finally{gate.resolve();f.close();}
});

test('the RPC wallet factory uses the shared production environment and preserves its authoritative owner',async()=>{
  const f=financeControllerFixture(),wasDev=env.isDev;
  try{
    loadEnv({env:'prod'});f.write(0);const old=await f.load('wallet/rpcWallet.js',0),common={};
    const wallet=old.createRpcWallet({common});assert.equal(wallet.authoritative,true);
    const owner=common[Symbol.for('gogame.authoritative.cash')];assert.ok(owner);
    f.write(1);const next=await f.load('wallet/rpcWallet.js',1),replacement=next.createRpcWallet({common});assert.notEqual(old.createRpcWallet,next.createRpcWallet);
    assert.equal(replacement.authoritative,true);assert.equal(common[Symbol.for('gogame.authoritative.cash')],owner);assert.equal(replacement.managed(),false);
  }finally{loadEnv({env:wasDev?'dev':'prod'});f.close();}
});

test('released financial namespaces, wallets and weak round state are collected while original callers remain usable',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-finance-controllers.mjs','--finance-controller-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_FINANCE_CONTROLLERS_GC/);
});

test('default-heap financial source replacement releases old compilation data while preserving a funded room',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-finance-controllers.mjs','--finance-controller-gc','--revisions=180','--max-growth-mib=12'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:45000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_FINANCE_CONTROLLERS_GC/);
  const report=JSON.parse(result.stdout.trim().split(/\r?\n/).find(line=>line.startsWith('PASS_REAL_FINANCE_CONTROLLERS_GC ')).slice('PASS_REAL_FINANCE_CONTROLLERS_GC '.length));
  assert.equal(report.stats.compiledEntries,1080);assert.equal(report.carryAmount,500);assert.equal(report.cashCalls,1);assert.ok(report.heapGrowthBytes<=12*1048576);
});
