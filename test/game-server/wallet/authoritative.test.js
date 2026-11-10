import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthoritativeWallet } from '../../../game-server/src/wallet/authoritative.js';
import { createRegistry } from '../../../game-server/src/registry.js';

async function fixture() {
  let stored={balance:1000,carry:null,revision:0,ttlMs:0};
  const requests=[];let reject=null,gate=null;
  const common={async cashRead(){return structuredClone(stored);},async cashApply(request){
    requests.push(structuredClone(request));if(gate)await gate;if(reject)throw reject;
    assert.equal(request.accounts[0].revision,stored.revision);
    const next=structuredClone(stored);
    for(const step of request.steps){
      if(step.kind==='reserve'){next.carry ||= {amount:0,revision:0,token:step.token,tableKey:step.tableKey};next.carry.amount+=step.amount;next.carry.revision++;}
      if(step.kind==='carryDelta'){next.balance+=step.amount;next.carry.amount+=step.amount;next.carry.revision++;}
      if(step.kind==='release'){next.carry.amount-=step.amount;next.carry.revision++;if(!next.carry.amount&&!step.keepOwner)next.carry=null;}
      if(step.kind==='debit')next.balance-=step.amount;
      if(step.kind==='credit')next.balance+=step.amount;
    }
    next.revision++;next.ttlMs=next.carry?300000:0;stored=next;
    return {accounts:[{...request.accounts[0],...structuredClone(stored)}]};
  }};
  const wallet=createAuthoritativeWallet({common}),registry=createRegistry(),session={userId:42,agentId:7,currency:'CNY',authenticated:true};
  const ws={readyState:1};registry.bind(ws,session);await wallet.load(session);
  const table={agentId:7,gameId:'holdem',roomId:1,roomType:19,kind:'normal',members:[],observers:[],phase:'idle'};
  registry.setTable(1,table,7,'holdem');
  const member={uid:42,point:0};table.members.push(member);
  const runtime={registry,wallet};
  return {wallet,runtime,session,member,table,common,requests,get stored(){return stored;},reject(error){reject=error;},wait(promise){gate=promise;}};
}

test('online carry and gameplay use one authoritative batch; release never credits wallet',async()=>{
  const f=await fixture();
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,600),f.runtime);
  assert.equal(f.stored.balance,1000);assert.equal(f.session.carryAmount,600);
  await f.wallet.run(()=>{f.member.point-=100;f.member.point+=200;},f.runtime);
  assert.equal(f.requests.at(-1).steps.length,2);
  assert.equal(f.session.wallet,1100);assert.equal(f.session.carryAmount,700);
  await f.wallet.run(()=>f.wallet.releaseCarry(f.session,f.member),f.runtime);
  assert.equal(f.session.wallet,1100);assert.equal(f.session.carryAmount,0);
  assert.deepEqual(f.requests.at(-1).steps.map(s=>s.kind),['release']);
  assert.ok(f.requests.every(r=>r.steps.every(s=>!('wagerId'in s))));
});

test('online success delivery waits for authoritative commit',async()=>{
  const f=await fixture(),delivered=[];let release;f.wait(new Promise(resolve=>{release=resolve;}));
  const running=f.wallet.run(()=>{f.wallet.reserveCarry(f.session,f.member,f.table,500);f.wallet.deliver(()=>delivered.push('success'));},f.runtime);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(delivered,[]);
  release();await running;assert.deepEqual(delivered,['success']);
});

test('rejected batch restores game state and drops success messages',async()=>{
  const f=await fixture(),delivered=[];
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  f.reject(Object.assign(new Error('version conflict'),{status:409}));
  await assert.rejects(f.wallet.run(()=>{f.member.point-=100;f.table.phase='playing';f.table.members.push({uid:99,point:1});f.wallet.deliver(()=>delivered.push('success'));},f.runtime),/version conflict/);
  assert.equal(f.table.phase,'idle');assert.equal(f.table.members.length,1);
  assert.equal(f.session.wallet,1000);assert.equal(f.member.point,500);assert.deepEqual(delivered,[]);
});

test('transport errors do not create recovery records or retry money automatically',async()=>{
  const f=await fixture();f.reject(Object.assign(new Error('timeout'),{status:504}));
  await assert.rejects(f.wallet.run(()=>f.wallet.debit(f.session,100),f.runtime),/timeout/);
  assert.equal(f.requests.length,1);assert.equal(f.session.wallet,1000);
  f.reject(null);await f.wallet.run(()=>{},f.runtime);
  assert.equal(f.requests.length,1,'later calls do not replay the earlier batch');
});

test('all other wagers use wallet minus carry and cannot issue unscoped money writes',async()=>{
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,800),f.runtime);
  assert.throws(()=>f.wallet.debit(f.session,1),{code:'WALLET_UNAVAILABLE'});
  await f.wallet.run(()=>{assert.equal(f.wallet.debit(f.session,201).ok,false);assert.equal(f.wallet.debit(f.session,200).ok,true);},f.runtime);
  assert.equal(f.session.wallet,800);assert.equal(f.session.carryAmount,800);
});

test('departed bettors and bankers refresh authoritative revisions before deferred payouts',async()=>{
  for(const retained of ['playerSessions','hundredBankers','casinoBankers']){
    const f=await fixture();f.runtime.registry.sessions.clear();f.table.members=[];
    if(retained==='playerSessions')f.table.playerSessions=new Map([[42,f.session],[91000001,{userId:91000001,agentId:7,bot:true}]]);
    else f.table[retained]={entries:[],refunds:[{session:f.session,e:{session:f.session},amount:100}]};
    f.stored.balance+=50;f.stored.revision++;
    await f.wallet.run(()=>f.wallet.credit(f.session,100),f.runtime);
    assert.equal(f.session.wallet,1150);assert.equal(f.stored.balance,1150);
    assert.equal(f.requests[0].accounts[0].revision,1,'offline account must not keep its old revision');
  }
});

test('releasing an expired reservation drops its strong member reference without changing money',async()=>{
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  const state=f.common[Symbol.for('gogame.authoritative.cash')];assert.equal(state.members.size,1);
  f.stored.carry=null;f.stored.revision++;
  await f.wallet.run(()=>f.wallet.releaseCarry(f.session,f.member),f.runtime);
  assert.equal(state.members.size,0);assert.equal(f.session.wallet,1000);assert.equal(f.requests.length,1,'expired release must not generate another monetary operation');
});

test('lost acknowledgement after a committed payout cannot credit the same game result again',async()=>{
  const f=await fixture(),apply=f.common.cashApply;
  f.common.cashApply=async request=>{await apply(request);throw Object.assign(new Error('reply timed out after commit'),{status:504});};
  const settle=()=>{if(!f.table.paid){f.wallet.credit(f.session,200,{key:'same-round'});f.table.paid=true;}};
  await assert.rejects(f.wallet.run(settle,f.runtime),/reply timed out/);
  assert.equal(f.stored.balance,1200);assert.equal(f.table.paid,undefined);
  await assert.rejects(f.wallet.run(settle,f.runtime),{code:'CASH_CONFIRMATION_REQUIRED'});
  assert.equal(f.stored.balance,1200);assert.equal(f.requests.length,1,'no replay or second monetary write after an uncertain commit');
  f.table.playerSessions=new Map([[42,f.session]]);
  assert.throws(()=>f.wallet.guardCashTable(f.table),{code:'CASH_CONFIRMATION_REQUIRED'});
  const hot=createAuthoritativeWallet({common:f.common});
  await assert.rejects(hot.run(()=>hot.credit(f.session,200),{...f.runtime,wallet:hot}),{code:'CASH_CONFIRMATION_REQUIRED'},'hot updates cannot silently unlock an uncertain account');
});

test('confirmed transaction rejection still permits a corrected subsequent operation',async()=>{
  const f=await fixture();f.reject(Object.assign(new Error('version conflict'),{code:9,status:409}));
  await assert.rejects(f.wallet.run(()=>f.wallet.credit(f.session,100),f.runtime),/version conflict/);
  f.reject(null);await f.wallet.run(()=>f.wallet.credit(f.session,100),f.runtime);assert.equal(f.stored.balance,1100);
});

test('an uncertain account does not prevent unrelated accounts from completing their own transactions',async()=>{
  const balances=new Map([[42,{balance:1000,revision:0,carry:null}],[43,{balance:5000,revision:0,carry:null}]]),requests=[];
  const common={async cashRead(a){return {...balances.get(a.userId)};},async cashApply(r){
    requests.push(r);const a=r.accounts[0],stored=balances.get(a.userId);assert.equal(a.revision,stored.revision);
    for(const step of r.steps)stored.balance+=step.amount;stored.revision++;
    if(a.userId===42)throw Object.assign(new Error('lost reply'),{status:504});
    return {accounts:[{...a,...stored}]};
  }};
  const wallet=createAuthoritativeWallet({common}),registry=createRegistry(),a={userId:42,agentId:7},b={userId:43,agentId:7};
  registry.bind({},a);registry.bind({},b);await wallet.load(a);await wallet.load(b);
  const runtime={registry,wallet};
  await assert.rejects(wallet.run(()=>wallet.credit(a,100),runtime),/lost reply/);
  await wallet.run(()=>wallet.credit(b,200),runtime);assert.equal(b.wallet,5200);
  assert.equal(balances.get(42).balance,1100);assert.equal(requests.length,2);
  const spectatorRoom={members:[],playerBets:new Map(),playerSessions:new Map([[42,a]])};
  assert.doesNotThrow(()=>wallet.guardCashTable(spectatorRoom),'watching an unrelated room cannot pause its games');
  spectatorRoom.playerBets.set(42,[{areaId:1,total:100}]);
  assert.throws(()=>wallet.guardCashTable(spectatorRoom),{code:'CASH_CONFIRMATION_REQUIRED'});
});

test('malformed or inconsistent successful commit replies never publish success or permit a repeated payout',async()=>{
  for(const corrupt of [
    ()=>({accounts:[]}),
    r=>({accounts:[{...r.accounts[0],balance:null}]}),
    r=>({accounts:[{...r.accounts[0],balance:999999}]}),
    r=>({accounts:[{...r.accounts[0],userId:999}]}),
    r=>({accounts:[{...r.accounts[0],revision:0}]}),
    r=>({accounts:[{...r.accounts[0],carry:{amount:1,revision:0,token:'unexpected',tableKey:'unexpected'},ttlMs:300000}]}),
  ]){
    const f=await fixture(),apply=f.common.cashApply,delivered=[];
    f.common.cashApply=async request=>corrupt(await apply(request));
    await assert.rejects(f.wallet.run(()=>{f.wallet.credit(f.session,100);f.wallet.deliver(()=>delivered.push('success'));},f.runtime),
      {code:'CASH_COMMIT_RESPONSE_INVALID'});
    assert.deepEqual(delivered,[]);assert.equal(f.stored.balance,1100);
    await assert.rejects(f.wallet.run(()=>f.wallet.credit(f.session,100),f.runtime),{code:'CASH_CONFIRMATION_REQUIRED'});
    assert.equal(f.requests.length,1);
  }
});
