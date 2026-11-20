import {importHotModule} from "../../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {compileReels}=await importHotModule(new URL("../../../game-server/src/core/slots-reels.js",import.meta.url).href,"core-helper-selected-test/game-server/core/slots-reels.test.js");
const {scratchCandidates,selectScratchPlan}=await importHotModule(new URL("../../../game-server/src/games/ggl-core/control-plan.js",import.meta.url).href,"ticket-selected-test");
import mj from '../../../game-server/src/games/ggl-mjhl/reel-config.js';
import queen from '../../../game-server/src/games/ggl-queen/reel-config.js';
import {WIN_MULTIPLIERS,prizeFromMask} from '../../../game-server/src/games/ggl-core/rules.js';

test('ordinary circular reel stops preserve the exact stop-count distribution',()=>{
  const sampler=compileReels({rows:1,strips:[[1,2],[1,2]]});
  assert.deepEqual([...sampler.distribution()].sort(),[[0,1n],[1,2n],[2,1n]]);
  for(const target of [0,1,2])for(let n=0;n<8;n++){
    const spin=sampler.sampleWhere(count=>count===target);
    assert.equal(spin.symbols.filter(symbol=>symbol===1).length,target);
    assert.ok(spin.stops.every(stop=>stop>=0&&stop<2));
  }
  assert.throws(()=>sampler.sampleWhere(count=>count===3),/cannot generate/);
  assert.throws(()=>sampler.sample(()=>99n),/random source/);
});

for(const [name,profile]of [['mj',mj],['queen',queen]])test(name+': game-server reel strips can produce every original scratch prize, including 10000x',()=>{
  const sampler=compileReels(profile),counts=sampler.distribution();
  assert.equal(counts.size,21);assert.equal([...counts.values()].reduce((a,b)=>a+b,0n),72n**5n);
  for(let count=0;count<=20;count++){
    const sample=sampler.sampleWhere(value=>value===count),prize=prizeFromMask(sample.symbols);
    assert.equal(sample.symbols.length,20);assert.equal(prize.huCount,count);assert.equal(prize.multiplier,count?WIN_MULTIPLIERS[count-1]:0);
  }
  const candidates=scratchCandidates(profile,1000);assert.equal(candidates.length,3);
  assert.ok(candidates.find(c=>c.id==='win').winAmount>1000);assert.ok(candidates.find(c=>c.id==='lose').winAmount<1000);
  assert.ok(candidates.every(c=>c.winAmount===c.faceValue*prizeFromMask(c.huMask).multiplier));
});

test('pool selection receives mapped game economics and adopts the exact generated result without paying it',async()=>{
  const calls=[],common={async finance(method,request,agent){calls.push({method,request,agent});const chosen=request.candidates.find(c=>c.id==='lose');
    return {code:0,mode:chosen.mode,selectedCandidateId:chosen.id,maxPayout:chosen.payout,decisionId:'confirmed-decision'};}};
  const plan=await selectScratchPlan(common,{route:{number:91061},agentId:7,userId:42,currency:'CNY',level:1,profile:mj,faceValue:1000});
  assert.equal(calls.length,1);assert.equal(calls[0].method,'getPoolControlDecision');assert.equal(calls[0].request.gameId,91061);
  assert.equal(calls[0].request.candidates[0].betAmount,'10.00');assert.equal(plan.selected,plan.candidates.find(c=>c.id==='lose'));
  assert.equal(plan.decisionId,'confirmed-decision');assert.ok(Object.isFrozen(plan.selected.huMask));
});

test('invalid strips, impossible advertised prizes and unconfirmed decisions cannot produce an issuance plan',async()=>{
  assert.throws(()=>scratchCandidates({rows:4,strips:Array.from({length:5},()=>[2,3,4,5])},100),/top prize/);
  assert.throws(()=>scratchCandidates(mj,123),/denomination/);
  assert.throws(()=>compileReels({rows:4,strips:[[1,2]]}),/strip/);
  await assert.rejects(()=>selectScratchPlan({finance:async()=>({code:0,selectedCandidateId:'invented',mode:'NATURAL',maxPayout:'0.00',decisionId:'bad'})},
    {route:{number:91061},agentId:7,userId:42,currency:'CNY',level:1,profile:mj,faceValue:100}),/valid generated/);
});
