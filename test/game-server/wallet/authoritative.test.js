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
