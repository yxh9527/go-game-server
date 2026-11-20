import {importHotModule} from "../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {createRpcScratchTickets}=await importHotModule(new URL("../../game-server/src/games/ggl-core/rpc-tickets.js",import.meta.url).href,"ticket-selected-test");
import {createGameRouteIndex} from '../../shared/rpc/game-routes.js';
import {ERROR} from '../../game-server/src/games/ggl-core/rules.js';
import config from '../../game-server/src/games/ggl-mjhl/config.js';
import {createHash} from 'node:crypto';

function fixture(){
  const calls=[],routes=createGameRouteIndex([{gameType:1004,roomType:61,number:91061,symbol:'test-mj',state:1,isFrozen:0}]);
  const common={async scratch(operation,input){calls.push({operation,input:structuredClone(input)});if(operation==='state')return {code:0,pendingTickets:[],denominations:config.denominations,winMultipliers:config.winMultipliers};
    if(operation==='allocate')return {code:0,matchedSerials:['ggl1-261110-0000001-01-7']};
    if(operation==='issue')return {code:0,newTickets:[{serialFull:input.candidates[0].tickets[0].serialFull,faceValue:input.faceValue,gglKind:'GGL1'}]};
    if(operation==='reveal')return {code:0,serialFull:input.serialFull,faceValue:100,huMask:Array(20).fill(2),huCount:0,multiplier:0,winAmount:0,prizeTier:'NONE',gglKind:'GGL1',purchaseRoomId:61010026,claimedAt:Date.now()};
    assert.fail('unexpected scratch operation');}};
  const ctx={table:{roomId:61010026,gameRoomId:62010026,roomType:61,cfg:{game_type:1004,finance_level:1},config},session:{agentId:7,userId:42,currency:'CNY',wallet:1000},runtime:{wallet:{guardExternalMoney(){},async load(){}}}};
  return {common,ctx,calls,service:createRpcScratchTickets(common,{routes})};
}
test('production ticket adapter only submits three pre-generated reel candidates and uses authority ownership',async()=>{
  const f=fixture();const result=await f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100});
  assert.equal(result.code,0);assert.deepEqual(f.calls.map(c=>c.operation),['state','allocate','issue','reveal']);
  const request=f.calls.find(c=>c.operation==='issue').input;
  assert.equal(request.gameId,91061);assert.equal(request.candidates.length,3);
  for(const candidate of request.candidates){assert.equal(candidate.tickets[0].huMask.length,20);assert.equal(candidate.tickets[0].reelVersion.length,64);assert.equal('strips'in candidate.tickets[0],false);}
  assert.equal(f.calls.at(-1).input.userId,42);
});
test('an uncertain purchase queries authority first and retries the identical private plan',async()=>{
  const f=fixture(),invoke=f.common.scratch;let first=true;
  f.common.scratch=async(...args)=>{const result=await invoke(...args);if(args[0]==='issue'&&first){first=false;throw Object.assign(new Error('lost ack'),{uncertain:true,code:4});}return result;};
  await f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100});
  const requests=f.calls.filter(c=>c.operation==='issue');assert.equal(requests.length,2);assert.deepEqual(requests[0].input,requests[1].input);
  const index=f.calls.findIndex(c=>c.operation==='issue');assert.equal(f.calls[index+1].operation,'state');
});
test('private state cannot leak future masks and claimed rewards must match the original ticket rule',async()=>{
  const f=fixture(),invoke=f.common.scratch;
  f.common.scratch=async(...args)=>{const result=await invoke(...args);if(args[0]==='state')result.pendingTickets=[{serialFull:'owned',faceValue:100,gglKind:'GGL1',winAmount:10000}];return result;};
  await assert.rejects(()=>f.service.state(f.ctx),e=>e.code===ERROR.STORAGE);
  f.common.scratch=async(...args)=>{const result=await invoke(...args);if(args[0]==='reveal')result.winAmount=10000;return result;};
  await assert.rejects(()=>f.service.reveal(f.ctx,{revealMode:'SPECIFIED',serialFull:'owned'}),e=>e.code===ERROR.STORAGE);
});

test('one account admits at most eight scratch tasks and rejects extra purchases before generating private plans or charging',async()=>{
  const f=fixture(),invoke=f.common.scratch;let release,active=0,maxActive=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.common.scratch=async(...args)=>{active++;maxActive=Math.max(maxActive,active);try{await gate;return await invoke(...args);}finally{active--;}};
  const tasks=Array.from({length:8},()=>f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(active,1);assert.equal(f.calls.length,0);
  for(let n=0;n<40;n++)await assert.rejects(f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100}),error=>error.code===ERROR.STORAGE&&error.message.includes('稍后重试'));
  assert.equal(f.calls.length,0,'rejected queued requests reached authority');
  const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,8);assert.equal(owner.pendingCounts.size,1);assert.equal(owner.tasks.size,1);
  release();await Promise.all(tasks);assert.equal(maxActive,1);assert.equal(f.calls.filter(call=>call.operation==='issue').length,8);
  assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
});

test('recreated scratch adapters share the same admission count and rejected tasks do not hold later tasks forever',async()=>{
  const f=fixture(),routes=createGameRouteIndex([{gameType:1004,roomType:61,number:91061,symbol:'test-mj',state:1,isFrozen:0}]);
  const second=createRpcScratchTickets(f.common,{routes}),invoke=f.common.scratch;let release;
  const gate=new Promise(resolve=>{release=resolve;});let failures=3;
  f.common.scratch=async(...args)=>{await gate;if(failures-->0)throw Object.assign(new Error('definite storage failure'),{businessCode:7});return invoke(...args);};
  const tasks=Array.from({length:8},(_,index)=>(index%2?second:f.service).state(f.ctx));
  // Attach rejection handlers while the tasks are still pending.
  const completed=Promise.allSettled(tasks);
  await assert.rejects(second.state(f.ctx),error=>error.code===ERROR.STORAGE);
  release();const results=await completed;assert.equal(results.filter(result=>result.status==='rejected').length,3);assert.equal(results.filter(result=>result.status==='fulfilled').length,5);
  const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
  assert.equal((await second.state(f.ctx)).code,0);assert.equal(owner.pendingTotal,0);
});

test('global scratch admission bounds many account closures while preserving independent account progress',async()=>{
  const f=fixture(),invoke=f.common.scratch;let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.common.scratch=async(...args)=>{await gate;return invoke(...args);};
  const context=userId=>({...f.ctx,session:{...f.ctx.session,userId}});
  const tasks=Array.from({length:256},(_,index)=>f.service.state(context(index+1)));
  const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,256);assert.equal(owner.pendingCounts.size,256);assert.equal(owner.tasks.size,256);
  await assert.rejects(f.service.state(context(300)),error=>error.code===ERROR.STORAGE);assert.equal(owner.pendingTotal,256);
  release();await Promise.all(tasks);assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
  assert.equal((await f.service.state(context(300))).code,0);
});

test('an uncounted pre-upgrade scratch tail drains before the new adapter can admit work',async()=>{
  const f=fixture(),owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];let finish;
  const old=new Promise(resolve=>{finish=resolve;});owner.tasks.set('7:42:CNY',old);
  old.then(()=>{if(owner.tasks.get('7:42:CNY')===old)owner.tasks.delete('7:42:CNY');});
  await assert.rejects(f.service.state(f.ctx),error=>error.code===ERROR.STORAGE);assert.equal(f.calls.length,0);assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);
  finish();await old;assert.equal((await f.service.state(f.ctx)).code,0);assert.equal(owner.tasks.size,0);assert.equal(owner.pendingTotal,0);
});

test('one slow scratch account does not block another and a wallet refresh failure releases its admission slot',async()=>{
  const f=fixture(),invoke=f.common.scratch;let release;
  const gate=new Promise(resolve=>{release=resolve;});
  f.common.scratch=async(operation,input)=>{if(input.userId===42)await gate;return invoke(operation,input);};
  const old=f.service.state(f.ctx),other={...f.ctx,session:{...f.ctx.session,userId:43}};
  assert.equal((await f.service.state(other)).code,0);
  const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,1);assert.equal(owner.pendingCounts.size,1);
  release();await old;assert.equal(owner.pendingTotal,0);
  f.ctx.runtime.wallet.load=async()=>{throw Error('wallet refresh failed');};
  await assert.rejects(f.service.state(f.ctx),/wallet refresh failed/);assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
});

test('queued purchase captures the original face, mode and selected serial array before any caller mutation',async()=>{
  const f=fixture(),invoke=f.common.scratch;let release,states=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.common.scratch=async(...args)=>{if(args[0]==='state'&&++states===1)await gate;return invoke(...args);};
  const first=f.service.state(f.ctx);await new Promise(resolve=>setImmediate(resolve));
  const body={faceValue:100,purchaseMode:'RANDOM_SINGLE',serialFulls:['original-serial']};
  const purchase=f.service.purchase(f.ctx,body);body.faceValue=200;body.purchaseMode='FULL_BOOK';body.serialFulls[0]='mutated-serial';body.serialFulls.push('added-serial');
  release();await first;assert.equal((await purchase).code,0);
  const issued=f.calls.find(call=>call.operation==='issue').input;
  assert.equal(issued.faceValue,100);assert.equal(issued.purchaseMode,'RANDOM_SINGLE');assert.deepEqual(issued.refs,['original-serial']);assert.equal(issued.candidates[0].tickets[0].serialFull,'original-serial');
  assert.equal(f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')].pendingTotal,0);
});

test('search and reveal snapshots cannot be redirected by changing the caller request after admission',async()=>{
  const f=fixture(),invoke=f.common.scratch,searches=[];
  f.common.scratch=async(operation,input)=>{if(operation==='search'){searches.push(structuredClone(input));return {code:0,matchedSerials:[]};}return invoke(operation,input);};
  const search={searchType:'BOOK_TAIL',bookTail:'789',ticketTail:''};const lookup=f.service.search(f.ctx,search);search.bookTail='123';search.searchType='SINGLE_TICKET';await lookup;
  assert.equal(searches[0].bookTail,'789');assert.equal(searches[0].searchType,'BOOK_TAIL');
  const body={revealMode:'SPECIFIED',serialFull:'original-owned'};const reveal=f.service.reveal(f.ctx,body);body.serialFull='foreign-owned';body.revealMode='RANDOM_BUY_REVEAL';
  assert.equal((await reveal).serialFull,'original-owned');assert.equal(f.calls.filter(call=>call.operation==='issue').length,0);assert.equal(f.calls.at(-1).input.serialFull,'original-owned');
});

test('queued account or room changes reject before reaching authority and release the original account counter',async()=>{
  for(const edit of [ctx=>{ctx.session.userId=43;},ctx=>{ctx.session.currency='USD';},ctx=>{ctx.table.roomId++;},ctx=>{ctx.table.cfg.finance_level++;}]){
    const f=fixture();const body={revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100};
    const result=f.service.reveal(f.ctx,body);edit(f.ctx);
    await assert.rejects(result,error=>error.code===ERROR.STORAGE&&error.message.includes('已变化'));
    assert.equal(f.calls.length,0);const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
  }
});

test('purchase and immediate reveal keep one reel and payout config across RPC waits even for mutable config inputs',async()=>{
  const f=fixture(),invoke=f.common.scratch;
  f.ctx.table.config={...config,denominations:[...config.denominations],winMultipliers:[...config.winMultipliers],reelProfile:structuredClone(config.reelProfile)};
  const profile=structuredClone(f.ctx.table.config.reelProfile),version=createHash('sha256').update(JSON.stringify({profile,winMultipliers:config.winMultipliers,winSymbol:1})).digest('hex');
  f.common.scratch=async(...args)=>{
    const result=await invoke(...args);
    if(args[0]==='state'){
      f.ctx.table.config.denominations.length=0;f.ctx.table.config.winMultipliers.fill(999);
      for(const strip of f.ctx.table.config.reelProfile.strips)strip.fill(2);
    }
    return result;
  };
  const result=await f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100});assert.equal(result.code,0);
  const request=f.calls.find(call=>call.operation==='issue').input;
  assert.ok(request.candidates.every(candidate=>candidate.tickets.every(ticket=>ticket.reelVersion===version)));
  assert.ok(request.candidates.find(candidate=>candidate.mode==='PLAYER_WIN').tickets[0].huMask.some(symbol=>symbol===1));
  assert.equal(f.calls.filter(call=>call.operation==='issue').length,1);assert.equal(f.calls.filter(call=>call.operation==='reveal').length,1);
});

test('state reply validates against its original config rather than a replacement installed while waiting',async()=>{
  const f=fixture(),invoke=f.common.scratch;
  f.common.scratch=async(...args)=>{const result=await invoke(...args);if(args[0]==='state')f.ctx.table.config={...config,denominations:[200],winMultipliers:[999]};return result;};
  assert.equal((await f.service.state(f.ctx)).code,0);
});

test('a confirmed purchase cannot refresh the wallet of a different account if session identity changes in flight',async()=>{
  const f=fixture(),invoke=f.common.scratch;let refreshes=0;
  f.ctx.runtime.wallet.load=async()=>{refreshes++;};
  f.common.scratch=async(...args)=>{const result=await invoke(...args);if(args[0]==='issue')f.ctx.session.userId=43;return result;};
  await assert.rejects(f.service.reveal(f.ctx,{revealMode:'RANDOM_BUY_REVEAL',serialFull:'',faceValue:100}),error=>error.code===ERROR.STORAGE&&error.message.includes('刷新钱包'));
  assert.equal(refreshes,0);assert.equal(f.calls.filter(call=>call.operation==='issue').length,1);assert.ok(f.calls.every(call=>call.input.userId===42));assert.equal(f.calls.some(call=>call.operation==='reveal'),false);
  const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
});

test('malformed or oversized request snapshots fail before occupying a queue slot or contacting authority',async()=>{
  const f=fixture();
  for(const body of [null,[],{faceValue:{}},{faceValue:1.5},{serialFull:{}},{serialFull:'a'.repeat(161)},{serialFulls:Array(101).fill('serial')},{bookId7List:[{}]}])await assert.rejects(f.service.purchase(f.ctx,body),error=>error.code===ERROR.INVALID);
  assert.equal(f.calls.length,0);const owner=f.common[Symbol.for('gogame.scratch.rpc.tasks.v1')];assert.equal(owner.pendingTotal,0);assert.equal(owner.pendingCounts.size,0);assert.equal(owner.tasks.size,0);
});
