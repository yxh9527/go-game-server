import {importHotModule} from '../../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {createAuthoritativeWallet}=await importHotModule(new URL('../../../game-server/src/wallet/authoritative.js',import.meta.url).href,'wallet-controller-regression');
import { createRegistry } from '../../../game-server/src/registry.js';
import {createSessionControl} from '../../../game-server/src/session-control.js';
import {createHandler} from '../../../game-server/src/create-handler.js';

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

test('a stale balance response cannot overwrite another user, agent or currency after session identity changes',async()=>{
  for(const patch of [{userId:43},{agentId:8},{currency:'USD'}]){
    const f=await fixture(),other={userId:42,agentId:7,currency:'CNY',...patch};
    const same=account=>account.userId===other.userId&&account.agentId===other.agentId&&account.currency===other.currency;
    let release,requested;
    f.common.cashRead=async account=>{if(same(account))return {balance:800,revision:2,carry:null,ttlMs:0};requested=structuredClone(account);return new Promise(resolve=>{release=()=>resolve({balance:900,revision:3,carry:null,ttlMs:0});});};
    await f.wallet.load(other);assert.equal(other.wallet,800);
    const pending=f.wallet.load(f.session);await new Promise(resolve=>setImmediate(resolve));Object.assign(f.session,patch);release();
    await assert.rejects(pending,error=>error.code==='CARRY_CONFLICT'&&error.message.includes('账户已变化'));
    assert.deepEqual(requested,{agentId:7,userId:42,currency:'CNY'});assert.equal(other.wallet,800);assert.equal(other.carryAmount,0);assert.equal(f.requests.length,0);
    Object.assign(f.session,{agentId:7,userId:42,currency:'CNY'});assert.equal(f.session.wallet,1000,'original account cache was changed by rejected response');
  }
});

test('an older cash read cannot restore a higher pre-debit balance after the confirmed commit',async()=>{
  const f=await fixture(),invoke=f.common.cashRead;let release,first=true;
  f.common.cashRead=async(...args)=>{const result=await invoke(...args);if(first){first=false;await new Promise(resolve=>{release=resolve;});}return result;};
  const old=f.wallet.load(f.session);await new Promise(resolve=>setImmediate(resolve));
  await f.wallet.run(()=>f.wallet.debit(f.session,100),f.runtime);assert.equal(f.session.wallet,900);assert.equal(f.stored.balance,900);
  release();await old;assert.equal(f.session.wallet,900,'late pre-debit read restored spendable balance');assert.equal(f.requests.length,1);
  await f.wallet.run(()=>{assert.equal(f.wallet.debit(f.session,901).ok,false);},f.runtime);assert.equal(f.requests.length,1);
});

test('a delayed successful cash acknowledgement cannot overwrite a newer authoritative balance',async()=>{
  for(const kind of ['debit','credit']){
    const f=await fixture(),apply=f.common.cashApply,sent=[];let release,entered;
    const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
    f.common.cashApply=async request=>{const reply=await apply(request);entered();await gate;return reply;};
    const running=f.wallet.run(()=>{f.wallet[kind](f.session,100);f.table.phase='accepted';f.wallet.deliver(()=>sent.push(f.session.wallet));},f.runtime);
    await ready;
    try{
      f.stored.balance-=200;f.stored.revision++;
      await f.wallet.load(f.session);
    }finally{release();}
    await running;
    const expected=kind==='debit'?700:900;
    assert.equal(f.session.wallet,expected,'late acknowledgement replaced the newer balance');assert.equal(f.stored.balance,expected);
    assert.equal(f.table.phase,'accepted');assert.deepEqual(sent,[expected]);assert.equal(f.requests.length,1);
    await f.wallet.run(()=>f.wallet.debit(f.session,50),f.runtime);
    assert.equal(f.requests[1].accounts[0].revision,2);assert.equal(f.session.wallet,expected-50);
    assert.doesNotThrow(()=>f.wallet.guardExternalMoney(f.session),'valid delayed acknowledgement must not pause the account');
  }
});

test('a delayed carry acknowledgement cannot resurrect a lease already absent at the same revision',async()=>{
  const f=await fixture(),apply=f.common.cashApply;let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.common.cashApply=async request=>{const reply=await apply(request);entered();await gate;return reply;};
  const running=f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  await ready;
  try{f.stored.carry=null;f.stored.ttlMs=0;await f.wallet.load(f.session);}finally{release();}
  await running;
  assert.equal(f.session.wallet,1000);assert.equal(f.session.carryAmount,0,'late carry acknowledgement restored an expired reservation');
  assert.equal(f.member.point,0);assert.equal(f.wallet.carryRecord(f.session),null);assert.equal(f.requests.length,1);
});

test('cash acknowledgement latency does not extend the returned carry lifetime',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const f=await fixture(),apply=f.common.cashApply;let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.common.cashApply=async request=>{const reply=await apply(request);reply.accounts[0].ttlMs=1000;entered();await gate;return reply;};
  const running=f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  await ready;now+=600;release();await running;
  assert.equal(f.wallet.carryRecord(f.session).expiresAt,1800000001000,'acknowledgement latency renewed the carry lease');
  now+=401;assert.throws(()=>f.wallet.guardCashTable(f.table),{code:'CARRY_CONFLICT'});assert.equal(f.requests.length,1);
});

test('an older in-flight read of the acknowledged revision cannot extend its carry lease',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const f=await fixture(),read=f.common.cashRead,apply=f.common.cashApply;let releaseRead,first=true;
  f.common.cashRead=async(...args)=>{
    if(!first)return read(...args);first=false;
    return new Promise(resolve=>{releaseRead=()=>resolve({...structuredClone(f.stored),ttlMs:300000});});
  };
  const old=f.wallet.load(f.session);
  f.common.cashApply=async request=>{const reply=await apply(request);reply.accounts[0].ttlMs=1000;return reply;};
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  now+=600;releaseRead();await old;
  assert.equal(f.wallet.carryRecord(f.session).expiresAt,1800000001000);assert.equal(f.requests.length,1);
});

test('a delayed Lottery verification read cannot replace a newer balance or pause confirmed gameplay',async()=>{
  const f=await fixture(),read=f.common.cashRead,sent=[];let release,entered,verify=false,bets=0;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.wallet.configureLottery({async bet(){bets++;f.stored.balance-=100;f.stored.revision++;verify=true;return {ok:true};}},[19]);
  f.common.cashRead=async(...args)=>{const reply=await read(...args);if(verify){verify=false;entered();await gate;}return reply;};
  const running=f.wallet.run(()=>{
    f.wallet.debit(f.session,100,{finance:{kind:'bet',table:f.table,round:{},bets:[{areaId:1,amount:100}]}});
    f.table.phase='accepted';f.wallet.deliver(()=>sent.push(f.session.wallet));
  },f.runtime);
  await ready;
  try{f.stored.balance-=200;f.stored.revision++;await createAuthoritativeWallet({common:f.common}).load(f.session);}finally{release();}
  await running;
  assert.equal(f.session.wallet,700);assert.equal(f.stored.balance,700);assert.equal(f.table.phase,'accepted');assert.deepEqual(sent,[700]);
  assert.equal(bets,1);assert.equal(f.requests.length,0);assert.doesNotThrow(()=>f.wallet.guardExternalMoney(f.session));
});

test('Lottery verification latency does not extend a funded carry lease',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  f.stored.ttlMs=1000;
  const read=f.common.cashRead;let release,entered,verify=false;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.wallet.configureLottery({async bet(){f.stored.balance-=100;f.stored.revision++;verify=true;return {ok:true};}},[19]);
  f.common.cashRead=async(...args)=>{const reply=await read(...args);if(verify){verify=false;entered();await gate;}return reply;};
  const running=f.wallet.run(()=>f.wallet.debit(f.session,100,{finance:{kind:'bet',table:f.table,round:{},bets:[{areaId:1,amount:100}]}}),f.runtime);
  await ready;now+=600;release();await running;
  assert.equal(f.session.wallet,900);assert.equal(f.wallet.carryRecord(f.session).expiresAt,1800000001000);
  now+=401;assert.throws(()=>f.wallet.guardCashTable(f.table),{code:'CARRY_CONFLICT'});assert.equal(f.requests.length,1);
});

test('a newer balance observation does not excuse an invalid cash acknowledgement',async()=>{
  const f=await fixture(),apply=f.common.cashApply,sent=[];let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  f.common.cashApply=async request=>{const reply=await apply(request);reply.accounts[0].balance=999999;entered();await gate;return reply;};
  const running=f.wallet.run(()=>{f.wallet.debit(f.session,100);f.wallet.deliver(()=>sent.push('invalid success'));},f.runtime);
  const rejected=assert.rejects(running,{code:'CASH_COMMIT_RESPONSE_INVALID'});
  await ready;
  try{f.stored.balance-=200;f.stored.revision++;await f.wallet.load(f.session);}finally{release();}
  await rejected;
  assert.equal(f.session.wallet,700);assert.equal(f.stored.balance,700);assert.deepEqual(sent,[]);assert.equal(f.requests.length,1);
  assert.throws(()=>f.wallet.guardExternalMoney(f.session),{code:'CASH_CONFIRMATION_REQUIRED'});
});

test('older and newer cash replies may finish in either order without lowering the observed revision',async()=>{
  const f=await fixture(),pending=[];
  f.common.cashRead=account=>new Promise(resolve=>pending.push({account,resolve}));
  const a={agentId:7,userId:42,currency:'CNY'},b={...a};
  const first=f.wallet.load(a),second=f.wallet.load(b);
  pending[1].resolve({balance:700,revision:2,carry:null,ttlMs:0});await second;
  pending[0].resolve({balance:950,revision:1,carry:null,ttlMs:0});await first;
  assert.equal(a.wallet,700);assert.equal(b.wallet,700);assert.equal(f.session.wallet,700);
  // Revision is authoritative even if an earlier-started query sees a newer
  // committed state than a later-started query.
  const third=f.wallet.load(a),fourth=f.wallet.load(b);
  pending[3].resolve({balance:600,revision:3,carry:null,ttlMs:0});await fourth;
  pending[2].resolve({balance:500,revision:4,carry:null,ttlMs:0});await third;
  assert.equal(a.wallet,500);assert.equal(b.wallet,500);assert.equal(f.requests.length,0);
});

test('an old same-revision carry reply cannot resurrect a lease already absent in a later read',async()=>{
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  const pending=[];f.common.cashRead=()=>new Promise(resolve=>pending.push(resolve));
  const withCarry=structuredClone(f.stored),old=f.wallet.load(f.session),fresh=f.wallet.load(f.session);
  pending[1]({balance:1000,revision:withCarry.revision,carry:null,ttlMs:0});await fresh;assert.equal(f.session.carryAmount,0);
  pending[0]({...withCarry,ttlMs:300000});await old;
  assert.equal(f.session.carryAmount,0);assert.equal(f.wallet.carryRecord(f.session),null);assert.equal(f.requests.length,1);
});

test('cash-read latency and repeated same-revision queries do not extend a funded carry lease',async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  const original={...structuredClone(f.stored),ttlMs:1000};let release;
  f.common.cashRead=()=>new Promise(resolve=>{release=()=>resolve(original);});
  const pending=f.wallet.load(f.session);now+=600;release();await pending;
  assert.equal(f.wallet.carryRecord(f.session).expiresAt,1800000001000,'reply latency was added to carry lifetime');
  now+=100;f.common.cashRead=async()=>({...original,ttlMs:1000});await f.wallet.load(f.session);
  assert.equal(f.wallet.carryRecord(f.session).expiresAt,1800000001000,'same revision query renewed original expiry');
  now=1800000001001;assert.throws(()=>f.wallet.guardCashTable(f.table),{code:'CARRY_CONFLICT'});
  assert.equal(f.requests.length,1,'read/expiry must not initiate a money mutation');
});

test('wallet recreation shares read ordering so an old adapter cannot overwrite a newer carry observation',async()=>{
  const f=await fixture(),pending=[];f.common.cashRead=()=>new Promise(resolve=>pending.push(resolve));
  const old=f.wallet.load(f.session),next=createAuthoritativeWallet({common:f.common}),second={agentId:7,userId:42,currency:'CNY'},fresh=next.load(second);
  pending[1]({balance:800,revision:1,carry:null,ttlMs:0});await fresh;
  pending[0]({balance:900,revision:0,carry:null,ttlMs:0});await old;
  assert.equal(second.wallet,800);assert.equal(f.session.wallet,800);assert.equal(f.requests.length,0);
});

test('invalid cash-read carry data never poisons the previously loaded balance or lease',async()=>{
  for(const patch of [{ttlMs:undefined},{ttlMs:NaN},{ttlMs:-1},{ttlMs:1.5},{carry:{amount:1001,revision:1,token:'t',tableKey:'room'}},{carry:{amount:500,revision:-1,token:'t',tableKey:'room'}},{carry:{amount:500,revision:1,token:'',tableKey:'room'}}]){
    const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
    const before=f.wallet.carryRecord(f.session);
    f.common.cashRead=async()=>({balance:1000,revision:2,carry:{amount:500,revision:1,token:'t',tableKey:'room'},ttlMs:300000,...patch});
    await assert.rejects(f.wallet.load(f.session),/Invalid authoritative carry lease/);
    assert.equal(f.session.wallet,1000);assert.deepEqual(f.wallet.carryRecord(f.session),before);assert.equal(f.requests.length,1);
  }
});

test('an asynchronous action submits its original snapshot revision even if a refresh observes an external commit',async()=>{
  const f=await fixture(),apply=f.common.cashApply;
  f.common.cashApply=async request=>{
    if(request.accounts[0].revision!==f.stored.revision){f.requests.push(structuredClone(request));throw Object.assign(new Error('cash version conflict'),{code:9,status:409});}
    return apply(request);
  };
  await assert.rejects(f.wallet.run(async()=>{
    assert.equal(f.wallet.debit(f.session,100).ok,true);
    // Simulate a separately committed wallet credit while this action awaits.
    f.stored.balance+=200;f.stored.revision++;
    await f.wallet.load(f.session);assert.equal(f.session.wallet,900,'staged view changed under the action');
  },f.runtime),/cash version conflict/);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].accounts[0].revision,0);assert.equal(f.stored.balance,1200);assert.equal(f.session.wallet,1200);
  await f.wallet.run(()=>f.wallet.debit(f.session,100),f.runtime);
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].accounts[0].revision,1);assert.equal(f.stored.balance,1100);assert.equal(f.session.wallet,1100);
});

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

test('a hundred-only Lottery rollout preserves ordinary seat reservations and their original cash writer',async()=>{
  const f=await fixture();f.wallet.configureLottery({});
  assert.equal(f.wallet.lotteryFor(f.table),null);
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,600),f.runtime);
  await f.wallet.run(()=>{f.member.point-=100;f.member.point+=200;},f.runtime);
  assert.equal(f.session.wallet,1100);assert.equal(f.member.point,700);
  assert.deepEqual(f.requests.at(-1).steps.map(step=>step.kind),['carryDelta','carryDelta']);
});

test('a failed socket delivery after confirmed cash commit cannot roll back game state or block the next transaction',async()=>{
  const f=await fixture(),sent=[],logs=[];f.runtime.log={error:(...args)=>logs.push(args)};
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  const result=await f.wallet.run(()=>{
    f.member.point-=100;f.table.phase='settled';
    f.wallet.deliver(()=>{throw Error('socket closed after commit');});
    f.wallet.deliver(()=>sent.push('other player update'));return 'confirmed';
  },f.runtime);
  assert.equal(result,'confirmed');assert.equal(f.stored.balance,900);assert.equal(f.session.wallet,900);assert.equal(f.member.point,400);assert.equal(f.table.phase,'settled');assert.deepEqual(sent,['other player update']);assert.equal(logs.length,1);
  await f.wallet.run(()=>f.wallet.credit(f.session,50),f.runtime);assert.equal(f.stored.balance,950);assert.equal(f.session.wallet,950);assert.equal(f.requests.length,3);
});

test('Lottery-confirmed actions preserve balances and continue deliveries when a notification throws',async()=>{
  const f=await fixture(),sent=[],logs=[];let bets=0;
  f.runtime.log={error:(...args)=>logs.push(args)};
  f.wallet.configureLottery({async bet(){bets++;f.stored.balance-=100;f.stored.revision++;return {ok:true};}},[19]);
  await f.wallet.run(()=>{
    assert.equal(f.wallet.debit(f.session,100,{finance:{kind:'bet',table:f.table,round:{},bets:[{areaId:1,amount:100}]}}).ok,true);
    f.table.phase='accepted';f.wallet.deliver(()=>{throw Error('Lottery notification unavailable');});f.wallet.deliver(()=>sent.push('other recipient'));
  },f.runtime);
  assert.equal(bets,1);assert.equal(f.requests.length,0);assert.equal(f.stored.balance,900);assert.equal(f.session.wallet,900);assert.equal(f.table.phase,'accepted');assert.deepEqual(sent,['other recipient']);assert.equal(logs.length,1);
  assert.doesNotThrow(()=>f.wallet.guardExternalMoney(f.session));await f.wallet.run(()=>{},f.runtime);assert.equal(bets,1,'notification failure retried a wager');
});

test('asynchronous notification rejection is logged once without delaying confirmed state or replaying money',async()=>{
  const f=await fixture(),logs=[],sent=[];f.runtime.log={error:(...args)=>logs.push(args)};
  await f.wallet.run(()=>{
    f.wallet.credit(f.session,100);f.table.phase='settled';
    f.wallet.deliver(async()=>{await Promise.resolve();throw Error('late socket failure');});f.wallet.deliver(()=>sent.push('sent'));
  },f.runtime);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(logs.length,1);assert.equal(f.session.wallet,1100);assert.equal(f.stored.balance,1100);assert.equal(f.table.phase,'settled');assert.deepEqual(sent,['sent']);assert.equal(f.requests.length,1);
  assert.doesNotThrow(()=>f.wallet.guardExternalMoney(f.session));await f.wallet.run(()=>{},f.runtime);assert.equal(f.requests.length,1);
});

test('notification and logger failures cannot turn a successful game action without cash steps into a failed action',async()=>{
  const f=await fixture(),sent=[];f.runtime.log={error(){throw Error('logger unavailable');}};
  const result=await f.wallet.run(()=>{f.table.phase='waiting';f.wallet.deliver(()=>{throw Error('socket unavailable');});f.wallet.deliver(()=>sent.push('other'));return 42;},f.runtime);
  assert.equal(result,42);assert.equal(f.table.phase,'waiting');assert.deepEqual(sent,['other']);assert.equal(f.requests.length,0);assert.equal(f.session.wallet,1000);
});

test('rejected game actions never send queued success notifications',async()=>{
  const f=await fixture(),sent=[];await assert.rejects(f.wallet.run(()=>{
    f.table.phase='changed';f.wallet.deliver(()=>sent.push('must not send'));throw Error('invalid action');
  },f.runtime),/invalid action/);
  assert.deepEqual(sent,[]);assert.equal(f.table.phase,'idle');assert.equal(f.requests.length,0);
});

test('online success delivery waits for authoritative commit',async()=>{
  const f=await fixture(),delivered=[];let release;f.wait(new Promise(resolve=>{release=resolve;}));
  const running=f.wallet.run(()=>{f.wallet.reserveCarry(f.session,f.member,f.table,500);f.wallet.deliver(()=>delivered.push('success'));},f.runtime);
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(delivered,[]);
  release();await running;assert.deepEqual(delivered,['success']);
});

test('asynchronous ticks finish before post-round cleanup, and cash confirmation waits for that cleanup',async()=>{
  const f=await fixture(),events=[],sent=[];Object.assign(f.runtime,{env:'dev',hotVersion:'tick-cleanup-order',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(19),oldTick=game.tick,oldAfter=game.afterRound;
  const table=game.createTable(700001,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100});table.agentId=7;table.members=[f.member];table.botTarget=0;
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,'holdem');f.session.roomId=table.roomId;
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,table,500),f.runtime);
  let releaseTick,releaseCleanup,enteredTick,enteredCleanup;
  const tickGate=new Promise(resolve=>{releaseTick=resolve;}),cleanupGate=new Promise(resolve=>{releaseCleanup=resolve;}),started=new Promise(resolve=>{enteredTick=resolve;}),cleaning=new Promise(resolve=>{enteredCleanup=resolve;});
  game.tick=async()=>{events.push('tick started');enteredTick();await tickGate;f.member.point-=100;table.phase='finished';events.push('tick finished');};
  game.afterRound=()=>{
    events.push('post-round');assert.equal(table.phase,'finished','post-round ran before engine finished');enteredCleanup();
    return cleanupGate.then(()=>{events.push('cleanup finished');f.wallet.deliver(()=>sent.push('confirmed'));});
  };
  // The first call is the original pre-tick admission check.
  let pre=true;const after=game.afterRound;game.afterRound=()=>{if(pre){pre=false;return;}return after();};
  try{
    const running=handler.tick();await started;assert.deepEqual(events,['tick started']);assert.equal(f.requests.length,1);assert.deepEqual(sent,[]);
    releaseTick();await cleaning;assert.deepEqual(events,['tick started','tick finished','post-round']);assert.equal(f.requests.length,1);assert.deepEqual(sent,[]);
    releaseCleanup();const result=await running;assert.equal(result[0].status,'fulfilled');assert.equal(f.requests.length,2);assert.equal(f.member.point,400);assert.equal(f.session.wallet,900);assert.deepEqual(sent,['confirmed']);assert.equal(events.at(-1),'cleanup finished');assert.equal(f.runtime.cashTickTask,undefined);
  }finally{releaseTick();releaseCleanup();game.tick=oldTick;game.afterRound=oldAfter;}
});

test('an asynchronously failed real game tick rolls back staged chips and never commits or sends partial results',async()=>{
  const f=await fixture(),logs=[],delivered=[];
  Object.assign(f.runtime,{env:'dev',hotVersion:'failed-tick-cash',configs:[],findConfig:()=>null,log:{info(){},warn(){},error:(...args)=>logs.push(args)}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(19),originalTick=game.tick,originalAfter=game.afterRound;
  const table=game.createTable(700001,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100});table.agentId=7;table.members=[f.member];table.botTarget=0;
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,'holdem');f.session.roomId=table.roomId;
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,table,500),f.runtime);const phase=table.phase;
  let admissions=0;game.afterRound=()=>{admissions++;};game.tick=async()=>{f.member.point-=100;table.phase='partial';f.wallet.deliver(()=>delivered.push('partial success'));await Promise.resolve();throw Error('asynchronous engine failure');};
  try{
    const result=await handler.tick();assert.equal(result.length,1);assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/asynchronous engine failure/);
    assert.equal(f.requests.length,1,'failed tick committed a partial financial mutation');assert.equal(f.stored.balance,1000);assert.equal(f.session.wallet,1000);assert.equal(f.member.point,500);assert.equal(table.phase,phase);assert.deepEqual(delivered,[]);assert.equal(f.runtime.cashTickTask,undefined);assert.ok(logs.some(row=>row[0]==='game tick failed'));
    assert.equal(admissions,1,'failed engine tick ran post-round cleanup');
    game.tick=async()=>{f.member.point-=50;table.phase='accepted';};await handler.tick();assert.equal(f.requests.length,2);assert.equal(f.member.point,450);assert.equal(f.stored.balance,950);assert.equal(table.phase,'accepted');
  }finally{game.tick=originalTick;game.afterRound=originalAfter;}
});

test('cleanup rejected after an awaited engine tick rolls back both stages without a cash write or success delivery',async()=>{
  const f=await fixture(),sent=[];Object.assign(f.runtime,{env:'dev',hotVersion:'async-cleanup-fails',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(19),oldTick=game.tick,oldAfter=game.afterRound;
  const table=game.createTable(700001,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100});table.agentId=7;table.members=[f.member];table.botTarget=0;
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,'holdem');f.session.roomId=table.roomId;
  await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,table,500),f.runtime);const phase=table.phase;let admissions=0;
  game.tick=async()=>{await Promise.resolve();f.member.point-=100;table.phase='engine finished';};
  game.afterRound=()=>{if(++admissions===1)return;assert.equal(table.phase,'engine finished');return Promise.resolve().then(()=>{f.member.point-=50;f.wallet.deliver(()=>sent.push('must not send'));throw Error('post-round cleanup failed');});};
  try{
    const result=await handler.tick();assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/post-round cleanup failed/);assert.equal(admissions,2);
    assert.equal(f.requests.length,1);assert.equal(f.stored.balance,1000);assert.equal(f.member.point,500);assert.equal(table.phase,phase);assert.deepEqual(sent,[]);assert.equal(f.runtime.cashTickTask,undefined);
  }finally{game.tick=oldTick;game.afterRound=oldAfter;}
});

test('the real common seat tick keeps an asynchronous play hook inside the original cash transaction',async()=>{
  for(const failed of [false,true]){
    const f=await fixture(),sent=[];Object.assign(f.runtime,{env:'dev',hotVersion:'seat-hook-cash',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
    const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(19),oldPlay=game.playTick,oldAfter=game.afterRound;
    const table=game.createTable(700001,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100,robot_behavior:{joinProbability:0,leaveProbability:0}});table.agentId=7;table.members=[f.member];table.botTarget=0;table.phase='playing';table.hand={marker:'original'};
    f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,'holdem');f.session.roomId=table.roomId;
    await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,table,500),f.runtime);const hand=table.hand;let release,started;
    const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});game.afterRound=()=>undefined;
    game.playTick=async()=>{f.member.point-=100;started();await gate;if(failed)throw Error('seat async hook failed');table.hand=null;table.phase='finished';f.wallet.deliver(()=>sent.push('confirmed'));};
    let running;
    try{
      running=handler.tick();await entered;assert.equal(f.requests.length,1);assert.deepEqual(sent,[]);release();const result=await running;
      assert.equal(result[0].status,failed?'rejected':'fulfilled');assert.equal(f.requests.length,failed?1:2);assert.equal(f.stored.balance,failed?1000:900);assert.equal(f.member.point,failed?500:400);assert.deepEqual(sent,failed?[]:['confirmed']);assert.equal(table.hand,failed?hand:null);assert.equal(f.runtime.cashTickTask,undefined);
    }finally{release();if(running)await running;game.playTick=oldPlay;game.afterRound=oldAfter;}
  }
});

test('a failed asynchronous hundred preparation stays within cash rollback and does not advance the cycle',async()=>{
  const f=await fixture(),sent=[];Object.assign(f.runtime,{env:'dev',hotVersion:'hundred-preparation-cash',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(58),oldBefore=game.beforeTick,oldPhases=game.phasesFor,oldCycle=game.onCycle,oldRobots=game.tickRobots,oldPush=game.pushState;
  const table=game.createTable(700001,58,{game_room_config_id:70,play_mode:0});table.agentId=7;table.hundredPhaseIndex=0;table.phaseEndsAt=0;
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,game.id);f.session.roomId=table.roomId;f.session.gameId=game.id;
  let release,entered,cycles=0;const gate=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  game.phasesFor=()=>[{state:2,cycle:1,seconds:1},{state:4,cycle:2,seconds:1}];game.onCycle=()=>{cycles++;};game.tickRobots=()=>{};game.pushState=()=>{};
  game.beforeTick=async()=>{f.wallet.credit(f.session,100);table.preparedMarker=true;f.wallet.deliver(()=>sent.push('must not send'));entered();await gate;throw Error('async preparation failed');};
  try{
    const ticking=handler.tick();await ready;assert.equal(cycles,0);assert.equal(f.requests.length,0);release();const result=await ticking;
    assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/async preparation failed/);assert.equal(cycles,0);assert.equal(f.requests.length,0);assert.equal(f.session.wallet,1000);assert.equal(f.stored.balance,1000);assert.equal(table.preparedMarker,undefined);assert.equal(table.hundredPhaseIndex,0);assert.deepEqual(sent,[]);assert.equal(f.runtime.cashTickTask,undefined);
  }finally{release();game.beforeTick=oldBefore;game.phasesFor=oldPhases;game.onCycle=oldCycle;game.tickRobots=oldRobots;game.pushState=oldPush;}
});

test('real hundred-engine completion precedes robot scheduling and a robot failure rolls the cycle back before cash commit',async()=>{
  const f=await fixture(),sent=[];Object.assign(f.runtime,{env:'dev',hotVersion:'hundred-engine-order',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(50),engine=game.engine,robots=game.tickRobots;
  const table=game.createTable(700001,50,{game_room_config_id:70,room_type:50,play_mode:1,hundred_min_bet:100,hundred_max_bet:10000});table.agentId=7;
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');f.runtime.registry.setTable(table.roomId,table,7,game.id);f.session.roomId=table.roomId;f.session.gameId=game.id;
  let release,started,calls=0;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{started=resolve;});
  game.engine={...engine,async tick(){started();await gate;f.wallet.credit(f.session,100);table.engineCompleted=true;}};
  game.tickRobots=()=>{calls++;assert.equal(table.engineCompleted,true);f.wallet.deliver(()=>sent.push('must not send'));throw Error('robot phase failed');};
  try{
    const pending=handler.tick();await entered;assert.equal(calls,0);assert.equal(f.requests.length,0);assert.ok(table.hundredCycleTask);
    release();const result=await pending;assert.equal(result[0].status,'rejected');assert.match(result[0].reason.message,/robot phase failed/);assert.equal(calls,1);assert.equal(f.requests.length,0);assert.equal(f.stored.balance,1000);assert.equal(f.session.wallet,1000);assert.equal(table.engineCompleted,undefined);assert.equal(table.hundredCycleTask,undefined);assert.deepEqual(sent,[]);
    game.engine={...engine,async tick(){await Promise.resolve();f.wallet.credit(f.session,50);table.engineCompleted=true;}};game.tickRobots=()=>{calls++;assert.equal(table.engineCompleted,true);};
    const next=await handler.tick();assert.equal(next[0].status,'fulfilled');assert.equal(f.requests.length,1);assert.equal(f.stored.balance,1050);assert.equal(calls,2);
  }finally{release();game.engine=engine;game.tickRobots=robots;}
});

test('a rejected room tick does not commit its partial result or prevent a different room from ticking',async()=>{
  const f=await fixture(),delivered=[];Object.assign(f.runtime,{env:'dev',hotVersion:'separate-tick-failure',configs:[],findConfig:()=>null,log:{info(){},warn(){},error(){}}});
  const handler=await createHandler(f.runtime),game=handler.games.byRoomType.get(19),oldTick=game.tick,oldAfter=game.afterRound;
  const a=game.createTable(700001,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100}),b=game.createTable(700002,19,{game_room_config_id:70,small_blind:5,big_blind:10,carry_min:100});
  f.runtime.registry.removeTable(f.table.roomId,7,'holdem');for(const table of [a,b]){table.agentId=7;table.botTarget=0;f.runtime.registry.setTable(table.roomId,table,7,'holdem');}
  a.members=[f.member];f.session.roomId=a.roomId;await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,a,500),f.runtime);const phase=a.phase;
  game.afterRound=()=>undefined;game.tick=async({table})=>{
    if(table===a){f.member.point-=100;table.phase='partial';f.wallet.deliver(()=>delivered.push('failed room'));await Promise.resolve();throw Error('one room failed');}
    f.wallet.credit(f.session,50);table.phase='completed';f.wallet.deliver(()=>delivered.push('healthy room'));
  };
  try{
    const result=await handler.tick();assert.deepEqual(result.map(row=>row.status),['rejected','fulfilled']);assert.equal(f.requests.length,2);assert.equal(f.stored.balance,1050);assert.equal(f.session.wallet,1050);assert.equal(f.member.point,500);assert.equal(a.phase,phase);assert.equal(b.phase,'completed');assert.deepEqual(delivered,['healthy room']);assert.equal(f.runtime.cashTickTask,undefined);
  }finally{game.tick=oldTick;game.afterRound=oldAfter;}
});

test('a rejected real wallet batch removes newly introduced prototype-name properties during rollback',async()=>{
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  f.reject(Object.assign(new Error('version conflict'),{status:409}));
  await assert.rejects(f.wallet.run(()=>{
    f.member.point-=100;
    for(const target of [f.table,f.member]){target.toString='new';target.constructor='new';Object.defineProperty(target,'__proto__',{value:'new',configurable:true});}
  },f.runtime),/version conflict/);
  assert.equal(f.member.point,500);assert.equal(f.session.wallet,1000);assert.equal(f.table.members[0],f.member);
  for(const target of [f.table,f.member])for(const key of ['toString','constructor','__proto__'])assert.equal(Object.hasOwn(target,key),false);
});

test('session lease revocation while cash commit awaits cannot be reversed by definite or uncertain transaction rollback',async()=>{
  for(const status of [409,504]){
    const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
    const ws=[...f.runtime.registry.sessions.keys()][0];let kicks=0,closed=0,release;
    ws.close=()=>{closed++;ws.readyState=3;};f.session.loginId='original-login';f.session.superseded=false;
    f.runtime.bus={gameSessions:{instanceId:'revocation-test',subscribe(){return ()=>{};},async verify(){return false;}}};
    const control=createSessionControl(f.runtime,{send(){kicks++;},close:async()=>{},kickId:1203});
    f.wait(new Promise(resolve=>{release=resolve;}));f.reject(Object.assign(new Error('cash response failure'),{status}));
    const transaction=f.wallet.run(()=>{f.member.point-=100;f.table.phase='playing';},f.runtime);
    // Observe the in-flight real cash adapter before revoking the session.
    for(let step=0;step<20&&f.requests.length<2;step++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.requests.length,2);assert.equal(await control.verify(ws,f.session),false);assert.equal(f.session.authenticated,false);assert.equal(f.session.superseded,true);
    release();await assert.rejects(transaction,/cash response failure/);
    assert.equal(f.member.point,500);assert.equal(f.table.phase,'idle');assert.equal(f.session.wallet,1000);
    assert.equal(f.session.authenticated,false,'rollback reinstated the old login');assert.equal(f.session.superseded,true,'rollback cleared a distributed revocation');assert.equal(kicks,1);assert.equal(closed,1);assert.equal(ws.readyState,3);
    assert.equal(f.requests.length,2,'revocation or rollback replayed a money operation');
  }
});

test('an asynchronous failed game action preserves revocation even before it reaches a cash writer',async()=>{
  const f=await fixture();await f.wallet.run(()=>f.wallet.reserveCarry(f.session,f.member,f.table,500),f.runtime);
  let started,release;const entered=new Promise(resolve=>{started=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const transaction=f.wallet.run(async()=>{f.member.point-=100;started();await gate;throw Error('action validation failed');},f.runtime);
  await entered;f.session.superseded=true;f.session.authenticated=false;release();await assert.rejects(transaction,/action validation failed/);
  assert.equal(f.member.point,500);assert.equal(f.session.authenticated,false);assert.equal(f.session.superseded,true);assert.equal(f.requests.length,1);
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
