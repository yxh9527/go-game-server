import test from 'node:test';
import assert from 'node:assert/strict';
import {createAuthoritativeWallet} from '../../../game-server/src/wallet/authoritative.js';
import {createRegistry} from '../../../game-server/src/registry.js';
import {MAX_CASH_ACCOUNTS,MAX_CASH_STEPS} from '../../../shared/cash-limits.js';

async function fixture(count){
  const store=new Map(),registry=createRegistry(),requests=[];
  const common={async cashRead(a){return {...store.get(a.userId)};},async cashApply(r){
    requests.push(r);
    // Preflight all accounts before changing even the first participant.
    for(const a of r.accounts)assert.equal(store.get(a.userId).revision,a.revision);
    for(const step of r.steps){const a=r.accounts[step.account-1];store.get(a.userId).balance+=step.amount;}
    for(const a of r.accounts)store.get(a.userId).revision++;
    return {accounts:r.accounts.map(a=>({...a,...store.get(a.userId)}))};
  }};
  const wallet=createAuthoritativeWallet({common}),players=[];
  for(let n=1;n<=count;n++){
    const session={userId:n,agentId:7,currency:'CNY',authenticated:true};
    store.set(n,{balance:1000,revision:0,carry:null});registry.bind({},session);await wallet.load(session);players.push(session);
  }
  return {wallet,players,store,requests,runtime:{registry,wallet}};
}
for(const count of [65,1000,MAX_CASH_ACCOUNTS])test('one atomic payout supports '+count+' accounts',async()=>{
  const f=await fixture(count);
  await f.wallet.run(()=>{for(const p of f.players)f.wallet.credit(p,200);},f.runtime);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].accounts.length,count);
  assert.ok(f.players.every(p=>p.wallet===1200));assert.ok([...f.store.values()].every(a=>a.revision===1));
});
test('oversized account or step transactions fail before sending any money',async()=>{
  const f=await fixture(MAX_CASH_ACCOUNTS+1);
  await assert.rejects(f.wallet.run(()=>{for(const p of f.players)f.wallet.credit(p,200);},f.runtime),{code:'CASH_CAPACITY_EXCEEDED'});
  assert.equal(f.requests.length,0);assert.ok(f.players.every(p=>p.wallet===1000));
  await assert.rejects(f.wallet.run(()=>{for(let i=0;i<=MAX_CASH_STEPS;i++)f.wallet.credit(f.players[0],1);},f.runtime),{code:'CASH_CAPACITY_EXCEEDED'});
  assert.equal(f.requests.length,0);assert.equal(f.players[0].wallet,1000);
});
