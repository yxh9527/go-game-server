import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {coreHelperFixture} from '../fixtures/hot-core-helpers.mjs';
import {collectibleCoreHelperFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

test('five shared projection and sampling helpers are selected without replacing resident wallet or room owners',()=>{
  assert.equal(collectibleCoreHelperFiles.length,5);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleCoreHelperFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../game-server/src/registry.js','../../shared/session-revocation-listener.js','../../shared/session-revocation-listener.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('old and new seat-view helpers share the connection offset without changing real seats or unmasking cards',async()=>{
  const f=coreHelperFixture();try{
    f.write(0);const old=await f.load('core/seat-view.js',0);
    const table={kind:'normal',gameId:'zjh',agentId:7,roomId:700001,roomRules:{maxPeople:7},members:[{uid:42,pos:2,point:1000},{uid:43,pos:6,point:1000}]},session={userId:99};
    const payload={memberList:table.members.map(member=>({...member,cardList:[-1,-1,-1]}))};
    const before=structuredClone(table),first=old.projectSeatMessage(table,session,2206,payload),offset=session.seatView;
    assert.equal(first.memberList[0].pos,0);assert.equal(first.memberList[1].pos,4);
    f.write(1);const next=await f.load('core/seat-view.js',1);assert.notEqual(old.projectSeatMessage,next.projectSeatMessage);
    const later=next.projectSeatMessage(table,session,3606,[{uid:43,pos:6,cardList:[-1,-1,-1]}]);assert.equal(later[0].pos,4);assert.deepEqual(later[0].cardList,[-1,-1,-1]);assert.equal(session.seatView,offset);assert.deepEqual(table,before);
    for(let pos=0;pos<7;pos++)assert.equal(next.restoreSeatRequest(table,session,5003,{position:pos}).position,old.restoreSeatRequest(table,session,5003,{position:pos}).position);
    table.hand={players:[{uid:42},{uid:43}]};table.members[0].pendingDeparture=true;
    assert.equal(next.needsSeatViewRefresh(table,session),false);assert.equal(old.projectSeatMessage(table,session,3741,{uid:43,pos:6}).pos,4);
  }finally{f.close();}
});

test('member projections keep original avatar identity and never expose nested wallet or private hand state after replacement',async()=>{
  const f=coreHelperFixture();try{
    f.write(0);const old=await f.load('core/member.js',0);f.write(1);const next=await f.load('core/member.js',1);
    const member={uid:42,name:'same player',icon:'90024',pos:2,point:1000,state:2,wallet:99999,hole:[1,2],carryDeadline:Date.now()+12000};
    const a=old.publicSeat(member),b=next.publicSeat(member);assert.equal(a.userInfo.icon,b.userInfo.icon);assert.match(b.userInfo.icon,/^\/avator\//);assert.equal(b.userInfo.name,'same player');assert.equal(b.pos,2);assert.equal(b.point,1000);assert.equal(b.wallet,undefined);assert.equal(b.hole,undefined);
    assert.deepEqual(next.memberListSeats([member],7).map(value=>value.pos),[0,1,2,3,4,5,6]);assert.equal(next.publicObserver(member).wallet,undefined);assert.deepEqual(member.hole,[1,2]);
  }finally{f.close();}
});

test('sampling versions preserve explicit-known-card permissions while their caches remain independently owned',async()=>{
  const f=coreHelperFixture();try{
    f.write(0);const old=await f.load('core/robot-cards.js',0);f.write(1);const next=await f.load('core/robot-cards.js',1);
    const bot={uid:3,bot:true};Object.defineProperty(bot,'hole',{get(){assert.fail('other robot private cards read');}});
    const hand={};Object.defineProperty(hand,'deck',{get(){assert.fail('future deck read');}});
    const opponents=next.humanCards([{uid:1},{uid:2,hole:[13,14,15]},bot],1),input={hand,uid:1,visible:[0,1],opponents,size:3};
    const before=old.sampleDeals(input),after=next.sampleDeals(input);assert.notEqual(before,after);assert.deepEqual(before,after);assert.equal(next.sampleDeals(input),after);assert.equal(old.sampleDeals(input),before);
    for(const deal of after){assert.deepEqual(deal.rivals[0],[13,14,15]);const cards=[...deal.own,...deal.rivals.flat()];assert.equal(new Set(cards).size,cards.length);}
    opponents[0].cards=[26,27,28];assert.notEqual(next.sampleDeals(input),after);assert.notEqual(next.hotTestSamplingCache,old.hotTestSamplingCache);
  }finally{f.close();}
});

test('wager checks and exact reel probabilities preserve invalid-input rejection and old immutable sampler behavior',async()=>{
  const f=coreHelperFixture();try{
    f.write(0);const old=await f.load('core/wager.js',0),reels=await f.load('core/slots-reels.js',0);f.write(1);const next=await f.load('core/wager.js',1),later=await f.load('core/slots-reels.js',1);
    for(const value of [-1,NaN,Infinity,{},[],true,'','0x64','1e2']){assert.ok(Number.isNaN(next.scoreAmount(value)));assert.equal(next.validWager(value,1000),false);}
    assert.equal(next.scoreAmount('1.25',100),125);assert.equal(next.scoreAmount('1.25',100),old.scoreAmount('1.25',100));assert.ok(Number.isNaN(next.checkedTotal([Number.MAX_SAFE_INTEGER,1])));assert.equal(next.beforeWagerDeadline(1000,1000),false);
    const profile=Object.freeze({rows:1,strips:Object.freeze([Object.freeze([1,2]),Object.freeze([1,2])])}),a=reels.compileReels(profile),b=later.compileReels(profile);
    assert.notEqual(a,b);assert.deepEqual([...b.distribution()], [...a.distribution()]);assert.equal(reels.compileReels(profile),a);assert.equal(later.compileReels(profile),b);
    for(const count of [0,1,2]){const spin=b.sampleWhere(value=>value===count,()=>0n);assert.equal(spin.symbols.filter(value=>value===1).length,count);assert.ok(Object.isFrozen(spin.symbols));}
    assert.throws(()=>b.sampleWhere(value=>value===3),/cannot generate/);assert.throws(()=>b.sample(()=>99n),/random source/);
  }finally{f.close();}
});

test('released member data, samplers and weak hand caches are collected while old retained calls still work',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-core-helpers.mjs','--core-helper-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_CORE_HELPERS_GC/);
});
