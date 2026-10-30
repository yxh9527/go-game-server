import test from 'node:test';
import assert from 'node:assert/strict';
import {createTournamentIdempotency,tournamentRequestKey,TOURNAMENT_DEDUP_TTL_MS as TTL,TOURNAMENT_DEDUP_SWEEP_MS as SWEEP} from '../../shared/tournament-idempotency.js';
import {createDevMatchPayments} from '../../cache/match/payments.js';
import {createDevTournamentWallet} from '../../cache/match/wallet.js';

test('completed dedup responses expire after one hour without extending on reads or reload; timer evicts idle entries',async t=>{
  t.mock.timers.enable({apis:['Date','setInterval'],now:100000});
  const runtime={},first=createTournamentIdempotency(runtime),state=runtime.tournamentIdempotency;
  t.after(()=>clearInterval(state.timer));
  let calls=0;
  const work=()=>({calls:++calls});
  const initial=await first.run('a',work);initial.calls=100;
  const expiry=state.entries.get('a').expiresAt;
  t.mock.timers.tick(TTL-1);
  assert.deepEqual(await first.run('a',work),{calls:1});
  const timer=state.timer,reloaded=createTournamentIdempotency(runtime);
  assert.equal(state.timer,timer);assert.equal(state.entries.get('a').expiresAt,expiry);
  t.mock.timers.tick(1);
  assert.equal(state.entries.size,0,'scheduled sweep removes entries without another request');
  assert.deepEqual(await reloaded.run('a',work),{calls:2});
  t.mock.timers.tick(TTL);
  assert.equal(state.entries.size,0);
  assert.equal(SWEEP,60000);
});

test('lazy expiry enforces the exact hour; unfinished operations and failures remain retry-safe',async t=>{
  let at=0,calls=0,finish;
  const runtime={clock:()=>at},dedup=createTournamentIdempotency(runtime);
  t.after(()=>clearInterval(runtime.tournamentIdempotency.timer));
  const work=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
  const pending=dedup.run('pending',work);await Promise.resolve();
  at=TTL*2;dedup.sweep();
  const duplicate=createTournamentIdempotency(runtime).run('pending',work);
  assert.equal(calls,1);finish({done:true});
  assert.deepEqual(await Promise.all([pending,duplicate]),[{done:true},{done:true}]);
  at+=TTL;
  assert.deepEqual(await dedup.run('pending',()=>({again:true})),{again:true});
  await assert.rejects(()=>dedup.run('failed',()=>{throw new Error('retry me');}),/retry me/);
  assert.equal(runtime.tournamentIdempotency.entries.has('failed'),false);
  assert.equal(runtime.tournamentIdempotency.pending.size,0);
  assert.equal(await dedup.run('failed',()=>42),42);
});

test('request keys include agent, match, operation and payload',()=>{
  const base={agentId:1,matchId:9,operation:'charge',plan:{key:'same',gold:10}};
  const original=tournamentRequestKey(base);
  for(const patch of [{agentId:2},{matchId:10},{operation:'refund'},{plan:{key:'same',gold:20}}]){
    assert.notEqual(tournamentRequestKey({...base,...patch}),original);
  }
});

test('local payments keep authoritative receipts after the one-hour request cache is swept',async t=>{
  let at=0,debits=0,credits=0;
  const runtime={config:{},clock:()=>at,rpc:{common:{debit:async()=>{debits++;return {ok:true};},credit:async()=>{credits++;return {ok:true};}}}};
  let payments=createDevMatchPayments(runtime);
  t.after(()=>clearInterval(runtime.tournamentIdempotency.timer));
  const plan={agentId:1,matchId:9,userId:10001,key:'match:1:9:10001:1',currency:'CNY',gold:100,service:10,total:110};
  await Promise.all([payments.charge(plan),payments.charge(plan)]);assert.equal(debits,1);
  at+=TTL;runtime.tournamentIdempotency.sweep();payments=createDevMatchPayments(runtime);
  assert.equal((await payments.charge(plan)).paidGold,100);assert.equal(debits,1);
  await payments.refund(plan,false);assert.equal(credits,1);
  at+=TTL;runtime.tournamentIdempotency.sweep();
  assert.equal((await payments.refund(plan,false)).refunded,100);assert.equal(credits,1);
  assert.equal(runtime.tournamentPayments.size,1,'payment journal must not expire with disposable responses');
});

test('game-process wallet cannot repeat a charge, refund or prize after cached control replies expire',async()=>{
  let balance=1000,debits=0,credits=0;
  const runtime={gateway:{getLoginData:async()=>({agentId:1})},registry:{sessions:new Map()},wallet:{
    load:async s=>{s.wallet=balance;},persist:async()=>{},
    debit:(s,n)=>{debits++;s.wallet-=n;balance=s.wallet;return {ok:true};},
    credit:(s,n)=>{credits++;s.wallet+=n;balance=s.wallet;return {ok:true};},
  }};
  let wallet=createDevTournamentWallet(runtime,()=>{});
  const plan={agentId:1,matchId:9,userId:10001,key:'match:1:9:10001:1',currency:'CNY',gold:100,service:10,total:110};
  const request=operation=>({agentId:1,matchId:9,operation,plan});
  await wallet(request('charge'));await wallet(request('refund'));
  const award={agentId:1,matchId:9,operation:'award',plan:{...plan,key:'match:1:9:award:10001:0',kind:'money',amount:50}};
  await wallet(award);wallet=createDevTournamentWallet(runtime,()=>{});
  await wallet(request('charge'));await wallet(request('refund'));await wallet(award);
  assert.equal(balance,1040);assert.equal(debits,1);assert.equal(credits,2);
});
