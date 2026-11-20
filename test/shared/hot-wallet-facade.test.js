import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {walletFacadeFixture} from '../fixtures/hot-wallet-facade.mjs';
import {env,loadEnv} from '../../shared/rpc/env.js';
import {collectibleWalletFacadeFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

function rpcFixture(){
  let balance=1000,debits=0,credits=0;
  const rpc={common:{async getBalance(){return balance;},debit(_uid,amount){debits++;if(amount>balance)return {ok:false,balance};balance-=amount;return {ok:true,balance};},credit(_uid,amount){credits++;balance+=amount;return {ok:true,balance};}}};
  return {rpc,get balance(){return balance;},get debits(){return debits;},get credits(){return credits;}};
}

test('the complete reviewed wallet facade chain is selected without selecting resident RPC or registry modules',()=>{
  assert.equal(collectibleWalletFacadeFiles.length,5);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleWalletFacadeFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/rpc/index.js','../../shared/rpc/env.js','../../game-server/src/registry.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('old and new wallet entries share the dev fallback and its original balance store',async()=>{
  const f=walletFacadeFixture();try{
    f.write(0);const old=await f.load('wallet/index.js',0),wallet=old.walletOf({}),a={agentId:7,userId:43101,currency:'CNY'};
    await wallet.load(a);old.credit(a,300,{});assert.equal(a.wallet,300);
    f.write(1);const next=await f.load('wallet/index.js',1),replacement=next.walletOf({}),b={...a};
    assert.notEqual(old.createWallet,next.createWallet);assert.equal(replacement,wallet);await replacement.load(b);assert.equal(b.wallet,300);
    assert.equal(next.debit(b,100,{}).ok,true);assert.equal(a.wallet,200);assert.equal(b.wallet,200);
  }finally{f.close();}
});

test('table fallback replacement preserves its funded member and releases only the original reservation',async()=>{
  const f=walletFacadeFixture();try{
    f.write(0);const old=await f.load('wallet/index.js',0),table={agentId:7,gameId:'holdem',roomId:7,roomType:19},a={agentId:7,userId:43102,currency:'CNY'},member={uid:a.userId,point:0};
    const wallet=old.walletOf({table});await wallet.load(a);wallet.credit(a,150);wallet.reserveCarry(a,member,table,100);const token=wallet.carryRecord(a).token;
    f.write(1);const next=await f.load('wallet/index.js',1);assert.equal(next.walletOf({table}),wallet);assert.equal(next.hasCarry(member),true);assert.equal(member.point,100);assert.equal(a.availableBalance,50);assert.equal(wallet.carryRecord(a).token,token);
    wallet.releaseCarry(a,member);wallet.releaseCarry(a,member);assert.equal(a.wallet,150);assert.equal(a.carryAmount,0);
  }finally{f.close();}
});

test('RPC wallet replacement preserves carry ownership and completed debit and credit results across the whole chain',async()=>{
  const f=walletFacadeFixture();try{
    const x=rpcFixture();f.write(0);const old=await f.load('wallet/index.js',0),a=old.createWallet({}, {rpc:x.rpc}),session={agentId:7,userId:43103,currency:'CNY'},member={uid:session.userId,point:0},table={agentId:7,gameId:'holdem',roomId:7,roomType:19};
    await a.load(session);a.reserveCarry(session,member,table,500);const token=a.carryRecord(session).token;a.debit(session,200,{key:'original-bet'});
    f.write(1);const next=await f.load('wallet/index.js',1),b=next.createWallet({}, {rpc:x.rpc});await b.load(session);
    assert.equal(b.carryRecord(session).token,token);assert.equal(b.carryRecord(session).amount,500);assert.equal(b.debit(session,200,{key:'original-bet'}).ok,true);assert.equal(x.debits,1);
    const payout={};b.credit(session,50,{operation:payout});a.credit(session,50,{operation:payout});assert.equal(x.credits,1);assert.equal(session.wallet,850);
    member.point-=100;assert.equal(x.balance,750);assert.equal(session.wallet,750);assert.equal(b.carryRecord(session).amount,400);assert.equal(x.debits,2);
    b.releaseCarry(session,member);a.releaseCarry(session,member);assert.equal(x.balance,750);assert.equal(session.carryAmount,0);assert.equal(x.credits,1);
  }finally{f.close();}
});

test('a pending operation stays attached to its original owner and rejects a changed amount after source replacement',async()=>{
  const f=walletFacadeFixture();let release;try{
    f.write(0);const old=await f.load('wallet/operations.js',0),owner={},session={agentId:7,userId:42,currency:'CNY',wallet:1000},operation={};let calls=0;
    const gate=new Promise(resolve=>{release=resolve;});
    const first=old.walletOperation(owner,session,100,'debit',{operation},async()=>{calls++;await gate;session.wallet=900;return {ok:true,balance:900};});
    f.write(1);const next=await f.load('wallet/operations.js',1),second=next.walletOperation(owner,session,100,'debit',{operation},()=>assert.fail('duplicate money call'));
    assert.throws(()=>next.walletOperation(owner,session,101,'debit',{operation},()=>assert.fail('changed money call')),/amount changed/);
    release();const replies=await Promise.all([first,second]);assert.equal(calls,1);assert.deepEqual(replies,[{ok:true,balance:900},{ok:true,balance:900}]);
  }finally{release?.();f.close();}
});

test('an original rejected operation clears only its old result and allows a later explicit request',async()=>{
  const f=walletFacadeFixture();try{
    f.write(0);const old=await f.load('wallet/operations.js',0),owner={},session={agentId:7,userId:42,currency:'CNY',wallet:1000},operation={};
    await assert.rejects(old.walletOperation(owner,session,100,'debit',{operation},async()=>{throw Error('original rejected');}),/original rejected/);
    f.write(1);const next=await f.load('wallet/operations.js',1);let calls=0;
    assert.deepEqual(next.walletOperation(owner,session,100,'debit',{operation},()=>{calls++;session.wallet=900;return {ok:true,balance:900};}),{ok:true,balance:900});assert.equal(calls,1);
  }finally{f.close();}
});

test('creating a replacement facade does not renew an existing carry deadline',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);const f=walletFacadeFixture();try{
    const x=rpcFixture();f.write(0);const old=await f.load('wallet/index.js',0),a=old.createWallet({}, {rpc:x.rpc}),session={agentId:7,userId:43104,currency:'CNY'},member={uid:session.userId,point:0},table={agentId:7,gameId:'holdem',roomId:7,roomType:19};
    await a.load(session);a.reserveCarry(session,member,table,500);const original=a.carryRecord(session);now+=10000;
    f.write(1);const next=await f.load('wallet/index.js',1),b=next.createWallet({}, {rpc:x.rpc});await b.load(session);assert.equal(b.carryRecord(session).expiresAt,original.expiresAt);assert.equal(b.carryRecord(session).token,original.token);
    now=original.expiresAt;assert.equal(b.carryRecord(session),null);assert.throws(()=>{member.point-=1;},{code:'CARRY_CONFLICT'});assert.equal(x.debits,0);assert.equal(x.balance,1000);
  }finally{f.close();}
});

test('production facade replacement stays authoritative and refuses the dev fallback and unconfigured online mutations',async()=>{
  const f=walletFacadeFixture(),wasDev=env.isDev;try{
    loadEnv({env:'prod'});f.write(0);const old=await f.load('wallet/index.js',0),common={},a=old.createWallet({}, {rpc:{common}}),owner=common[Symbol.for('gogame.authoritative.cash')];
    assert.equal(a.authoritative,true);assert.throws(()=>old.createWallet({mode:'local'}),/only available in dev/);assert.throws(()=>old.walletOf({}),/production wallet is required/);
    f.write(1);const next=await f.load('wallet/index.js',1),b=next.createWallet({}, {rpc:{common}});assert.equal(common[Symbol.for('gogame.authoritative.cash')],owner);assert.equal(b.authoritative,true);assert.equal(next.walletOf({wallet:b}),b);
    assert.throws(()=>b.debit({agentId:7,userId:42},100),{code:'WALLET_UNAVAILABLE'});assert.throws(()=>next.createWallet({mode:'online'}).load({userId:42}),/requires the data-center RPC adapter/);
  }finally{loadEnv({env:wasDev?'dev':'prod'});f.close();}
});

test('released wallet facade classes, instances and native-realm exports are collected across replacement',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-wallet-facade.mjs','--wallet-facade-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_WALLET_FACADE_GC/);
});
