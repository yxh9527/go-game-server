import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {financeHelperFixture} from '../fixtures/hot-finance-helpers.mjs';
import {collectibleFinanceHelperFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';
import {scoreToMoney as originalScore,moneyToScore as originalMoney} from '../../game-server/src/wallet/round-finance.js';

test('pure finance helpers remain selected alongside controllers while resident ownership and RPC stay separate',()=>{
  assert.equal(collectibleFinanceHelperFiles.length,3);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleFinanceHelperFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../game-server/src/registry.js','../../shared/session-revocation-listener.js','../../shared/rpc/index.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('new and old money helper versions preserve exact cent conversion, errors and legacy round-finance exports',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const old=await f.load('wallet/money-format.js',0);f.write(1);const next=await f.load('wallet/money-format.js',1);assert.notEqual(next.scoreToMoney,old.scoreToMoney);
    for(const amount of [0,1,99,100,101,Number.MAX_SAFE_INTEGER]){
      assert.equal(next.scoreToMoney(amount),old.scoreToMoney(amount));assert.equal(next.scoreToMoney(amount),originalScore(amount));
      assert.equal(next.moneyToScore(next.scoreToMoney(amount)),amount);assert.equal(originalMoney(next.scoreToMoney(amount)),amount);
    }
    assert.equal(next.scoreToMoney(-101,true),'-1.01');assert.equal(next.scoreToMoney(-Number.MAX_SAFE_INTEGER,true),'-90071992547409.91');
    for(const value of [NaN,Infinity,1.5,-1,{},[],'100'])assert.throws(()=>next.scoreToMoney(value),{code:'FINANCE_AMOUNT_INVALID',status:503});
    for(const value of ['1e2','-1','0x10','1.001','90071992547409.92',{},null])assert.throws(()=>next.moneyToScore(value),{code:'FINANCE_REJECTED',status:503});
  }finally{f.close();}
});

test('route replacement preserves the old round mapping and resolves only new rounds through the new catalogue',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const old=await f.load('shared/rpc/game-routes.js',0);f.write(1);const next=await f.load('shared/rpc/game-routes.js',1);
    const row=number=>({gameType:19,roomType:19,number,symbol:'pool-'+number,state:1,isFrozen:0}),a=old.createGameRouteIndex([row(91001)]),b=next.createGameRouteIndex([row(91002)]),round={},config={game_type:19,room_type:19};
    const first=old.bindRoundGameRoute(round,a,config);assert.equal(next.bindRoundGameRoute(round,b,config),first);assert.equal(round.financeGame.number,91001);assert.equal(next.bindRoundGameRoute({},b,config).number,91002);
    assert.throws(()=>next.bindRoundGameRoute(round,b,{...config,room_type:50}),{code:'GAME_ROUTE_INVALID'});assert.ok(Object.isFrozen(first));
    assert.throws(()=>next.createGameRouteIndex([row(91001),row(91001)]),{code:'GAME_ROUTE_INVALID'});
    assert.throws(()=>next.createGameRouteIndex([{...row(91001),isFrozen:1}]).resolve(19,19),{code:'GAME_FROZEN'});
    let lookups=0;assert.equal(await next.loadGameRoutes({env:'dev',rpc:{lobby:{listFinanceGames(){lookups++;}}}}),null);assert.equal(lookups,0);
  }finally{f.close();}
});

test('an original rollback closure still restores shared object identity and newly added prototype-name properties after replacement',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const old=await f.load('wallet/transaction-state.js',0);
    const symbol=Symbol('new'),member={point:100,name:'original'},hand={pot:50},table={members:[member],hand,values:new Map([[member,hand]]),ids:new Set([42])};table.self=table;
    const socket={};Object.defineProperty(socket,'secret',{get(){assert.fail('socket internals traversed');}});
    const runtime={wallet:{},registry:{tables:new Map([[1,table]]),sessions:new Map([[socket,{userId:42,member}]])}};
    const restore=old.captureGameState(runtime);f.write(1);const next=await f.load('wallet/transaction-state.js',1);assert.notEqual(next.captureGameState,old.captureGameState);
    member.point=0;member.name='changed';table.members.push({point:999});table.hand={pot:999};table.values.clear();table.ids.add(43);runtime.registry.tables.delete(1);
    for(const target of [table,member,hand]){Object.defineProperty(target,'__proto__',{value:'added',configurable:true,enumerable:true});target.toString='added';target.constructor='added';target[symbol]='added';}
    restore();assert.equal(runtime.registry.tables.get(1),table);assert.equal(table.members[0],member);assert.equal(table.members.length,1);assert.equal(table.hand,hand);assert.equal(member.point,100);assert.equal(member.name,'original');assert.equal(table.self,table);assert.equal(table.values.get(member),hand);assert.deepEqual([...table.ids],[42]);
    for(const target of [table,member,hand])for(const key of ['__proto__','toString','constructor',symbol])assert.equal(Object.hasOwn(target,key),false,'rollback left '+String(key));
    const again=next.captureGameState(runtime);member.point=20;again();assert.equal(member.point,100);
  }finally{f.close();}
});

test('rollback preserves existing own descriptors and skips ignored wallet-owned state',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    const member={point:100},ignored={balance:500},table={member,ignored};let reads=0;
    Object.defineProperty(table,'toString',{value:'original own',writable:true,configurable:true,enumerable:false});Object.defineProperty(table,'computed',{get(){reads++;return member.point;},configurable:true});
    const runtime={wallet:{},registry:{tables:new Map([[1,table]]),sessions:new Map()}},before=Object.getOwnPropertyDescriptor(table,'toString'),restore=captureGameState(runtime,[ignored]);
    table.toString='changed';ignored.balance=900;member.point=50;restore();assert.equal(reads,0);assert.equal(ignored.balance,900);assert.equal(member.point,100);assert.deepEqual(Object.getOwnPropertyDescriptor(table,'toString'),before);
  }finally{f.close();}
});

test('rollback keeps an existing connection revoked while restoring its game fields',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    for(const [revoke,superseded]of [[session=>{session.superseded=true;session.authenticated=false;},true],[session=>{session.superseded=true;},true],[session=>{session.authenticated=false;},undefined]]){
      const session={userId:42,authenticated:true,inRoom:true,roomId:7,seatView:{offset:2}},table={point:100},runtime={registry:{tables:new Map([[1,table]]),sessions:new Map([[{},session]])}};
      const restore=captureGameState(runtime);session.inRoom=false;session.roomId=99;session.seatView.offset=4;table.point=0;revoke(session);restore();
      assert.equal(session.authenticated,false);assert.equal(session.inRoom,true);assert.equal(session.roomId,7);assert.equal(session.seatView.offset,2);assert.equal(table.point,100);
      assert.equal(session.superseded,superseded);
    }
  }finally{f.close();}
});

test('rollback still reverses a failed initial authentication and does not revoke unaffected players',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    const initial={userId:42,authenticated:false},other={userId:43,authenticated:true,superseded:false},runtime={registry:{tables:new Map(),sessions:new Map([[{},initial],[{},other]])}};
    const restore=captureGameState(runtime);initial.authenticated=true;initial.inRoom=true;other.roomId=99;restore();
    assert.equal(initial.authenticated,false);assert.equal(initial.inRoom,undefined);assert.equal(other.authenticated,true);assert.equal(other.superseded,false);assert.equal(other.roomId,undefined);
  }finally{f.close();}
});

test('a completed snapshot restores once, then cannot overwrite subsequent accepted game state',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    const member={point:100},runtime={registry:{tables:new Map([[1,{member}]]),sessions:new Map()}};
    const restore=captureGameState(runtime);member.point=0;restore();assert.equal(member.point,100);
    member.point=200;restore();assert.equal(member.point,200,'completed callback rewound a later action');
    restore.discard();restore.discard();restore();assert.equal(member.point,200);
  }finally{f.close();}
});

test('discarding a successful transaction snapshot leaves committed state untouched and disables later restoration',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    const table={pot:100},runtime={registry:{tables:new Map([[1,table]]),sessions:new Map()}};
    const restore=captureGameState(runtime);table.pot=500;restore.discard();restore();assert.equal(table.pot,500);
  }finally{f.close();}
});

test('a failing restore still releases its snapshot and cannot keep retrying a partial rollback',async()=>{
  const f=financeHelperFixture();try{
    f.write(0);const {captureGameState}=await f.load('wallet/transaction-state.js',0);
    const table={pot:100},runtime={registry:{tables:new Map([[1,table]]),sessions:new Map()}},restore=captureGameState(runtime);
    Object.defineProperty(table,'pot',{value:999,writable:false,configurable:false});
    assert.throws(restore,TypeError);assert.doesNotThrow(restore);assert.doesNotThrow(()=>restore.discard());assert.equal(table.pot,999);
  }finally{f.close();}
});

test('completed snapshot callbacks do not retain removed hands, sessions, sockets or ignored financial objects',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/transaction-snapshot-gc.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_TRANSACTION_SNAPSHOT_GC/);
});

test('released money, route-index and rollback closures are garbage collected while old retained functions work',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-finance-helpers.mjs','--finance-helper-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_FINANCE_HELPERS_GC/);
});
