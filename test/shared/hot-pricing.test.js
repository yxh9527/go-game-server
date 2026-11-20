import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {pricingFixture} from '../fixtures/hot-pricing.mjs';
import {collectibleRuleFiles,collectibleModuleFiles,createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';
import baccarat from '../../game-server/src/games/baccarat/config.js';
import dragonTiger from '../../game-server/src/games/dragon-tiger/config.js';

test('five pricing and rule modules are selected without selecting bankroll or persistent transport state',()=>{
  assert.equal(collectibleRuleFiles.length,5);assert.equal(collectibleModuleFiles.length,242);assert.equal(new Set(collectibleModuleFiles).size,242);
  const loader=createCollectibleEntryLoader();for(const file of collectibleRuleFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/session-revocation-listener.js','../../shared/session-revocation-listener.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('baccarat base probability cache stays at eight entries and eviction recomputes identical original quotes',async()=>{
  const f=pricingFixture();try{
    f.write(0);const module=await f.load('games/baccarat/odds.js',0),shoe=[3,5,13,14,15,16,17,18],exposed={other:3,banker:5};
    const first=module.brightOdds(shoe,exposed,{...baccarat,decks:1});const firstBase=module.hotTestPricingCache.get(1);
    for(let decks=2;decks<=8;decks++)module.brightOdds(shoe,exposed,{...baccarat,decks});
    assert.equal(module.hotTestPricingCache.size,8);module.brightOdds(shoe,exposed,{...baccarat,decks:1});
    module.brightOdds(shoe,exposed,{...baccarat,decks:9});assert.equal(module.hotTestPricingCache.size,8);assert.ok(module.hotTestPricingCache.has(1));assert.equal(module.hotTestPricingCache.has(2),false);
    const second=module.brightOdds(shoe,exposed,{...baccarat,decks:2});assert.equal(module.hotTestPricingCache.size,8);
    for(let decks=10;decks<=17;decks++)module.brightOdds(shoe,exposed,{...baccarat,decks});
    assert.equal(module.hotTestPricingCache.has(1),false);assert.equal(module.hotTestPricingCache.has(2),false);
    assert.deepEqual(module.brightOdds(shoe,exposed,{...baccarat,decks:1}),first);assert.notEqual(module.hotTestPricingCache.get(1),firstBase);
    assert.deepEqual(module.brightOdds(shoe,exposed,{...baccarat,decks:2}),second);assert.equal(module.hotTestPricingCache.size,8);
    assert.deepEqual(shoe,[3,5,13,14,15,16,17,18]);
  }finally{f.close();}
});

test('new pricing versions preserve frozen hand quotes and do not mutate original shoe composition',async()=>{
  const f=pricingFixture();try{
    f.write(0);const old=await f.load('games/baccarat/odds.js',0),oldDragon=await f.load('games/dragon-tiger/odds.js',0);
    const shoe=[3,5,13,14,15,16,17,18],exposed={other:3,banker:5};const hand={areaOdds:old.brightOdds(shoe,exposed,{...baccarat,decks:1})},original=structuredClone(hand);
    const dragonShoe=Array.from({length:52},(_,i)=>i),dragonQuote=oldDragon.brightOdds(dragonShoe,5);
    f.write(1);const next=await f.load('games/baccarat/odds.js',1),nextDragon=await f.load('games/dragon-tiger/odds.js',1);
    assert.notEqual(next.configuredOdds,old.configuredOdds);assert.notEqual(next.hotTestPricingCache,old.hotTestPricingCache);
    assert.deepEqual(next.brightOdds(shoe,exposed,{...baccarat,decks:1}),hand.areaOdds);assert.deepEqual(hand,original);
    assert.deepEqual(nextDragon.brightOdds(dragonShoe,5),dragonQuote);assert.deepEqual(nextDragon.brightOdds(dragonShoe.toReversed(),5),dragonQuote);
    assert.deepEqual(nextDragon.configuredOdds(dragonTiger,3),oldDragon.configuredOdds(dragonTiger,3));
    assert.equal(shoe.length,8);assert.equal(dragonShoe.length,52);assert.equal(old.hotTestRevision,0);assert.equal(next.hotTestRevision,1);
  }finally{f.close();}
});

test('replacement rules keep room-owned critical deadlines and award the same capped side pots and integer arcade net',async()=>{
  const f=pricingFixture();try{
    const read=async revision=>{f.write(revision);return Promise.all(['holdem/critical.js','holdem/pots.js','core/turntable-rules.js'].map(file=>f.load(file,revision)));};
    const before=await read(0),after=await read(1),table={criticalFlag:true,criticalAnte:100,criticalInterval:'1',criticalAt:61000,createdAt:1000,bigBlind:10};
    before[0].initializeCritical(table,2000);after[0].initializeCritical(table,3000);assert.equal(table.criticalAt,61000);
    assert.equal(after[0].nextHandRules(table,60999).critical,false);assert.equal(table.criticalAt,61000);
    assert.deepEqual(before[0].nextHandRules({...table},61000),after[0].nextHandRules({...table},61000));
    const players=[{uid:1,pos:0,totalBet:100},{uid:2,pos:1,totalBet:200},{uid:3,pos:2,totalBet:500}],ranked=[{member:players[1],eval:2},{member:players[0],eval:1},{member:players[2],eval:0}];
    const a=before[1].awardPots(players,ranked,1,(a,b)=>a-b),b=after[1].awardPots(players,ranked,1,(a,b)=>a-b);assert.deepEqual([...a.payout],[...b.payout]);assert.equal([...b.payout.values()].reduce((n,value)=>n+value,0),800);assert.deepEqual(players.map(p=>p.totalBet),[100,200,500]);
    for(const type of [53,54,55,56,57]){const row={room_type:type},config={roomTypes:[type]};assert.deepEqual(after[2].roomRules(row,config),before[2].roomRules(row,config));}
    assert.equal(after[2].betNet({winningAreas:[1]},{areaId:1,total:100},{1:.29}),29);assert.deepEqual(after[2].winningAreas(1,2),before[2].winningAreas(1,2));
  }finally{f.close();}
});

test('old pricing functions, probability cache arrays and wheel profiles are garbage collected after release',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-pricing.mjs','--pricing-gc'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_PRICING_GC/);
});
