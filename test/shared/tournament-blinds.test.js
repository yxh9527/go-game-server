import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {normalizeTournamentLevels,blindAt,updateTournamentClock,tournamentRestSeconds,resumeTournamentClock}=await importHotModule(new URL('../../shared/tournament-blinds.js',import.meta.url).href,'tournament-regression');

const plan=()=>normalizeTournamentLevels([{type:1,min:'5',max:'10',bet:'0',interval:60},
  {type:3,min:0,max:0,bet:0,interval:10},{type:1,min:10,max:20,bet:2,interval:0}]);
test('rest levels retain prior blinds, identify the next playing level, and validate bounded plans',()=>{
  const config={startedAt:100000,levels:plan()};
  const rest=blindAt(config,165000);
  assert.equal(rest.resting,true);assert.equal(rest.smallBlind,5);assert.equal(rest.nextBigBlind,20);
  assert.equal(rest.currentBlindLv,1);assert.equal(rest.nextUpBlindTime,5);
  assert.equal(blindAt(config,170000).currentBlindLv,3);
  for(const levels of [[...plan(),{type:3,interval:10}],plan().map((l,i)=>i===1?{...l,type:4}:l),plan().map((l,i)=>i===1?{...l,interval:0}:l),Array(513).fill(plan()[0])]){
    assert.throws(()=>normalizeTournamentLevels(levels));
  }
});

test('type 2 waits for all hands and animations, then freezes until explicit resume into the next playing level',()=>{
 const levels=normalizeTournamentLevels([{type:1,min:5,max:10,interval:60},{type:2,interval:45},{type:1,min:10,max:20,interval:60},{type:2},{type:1,min:20,max:40,interval:0}]);
 assert.equal(levels[1].interval,0);assert.equal(levels[3].interval,0);
 const tables=[{hand:{},phase:'playing',startAt:0,mtt:{}},{hand:null,phase:'idle',startAt:0,mtt:{}}],match={config:{startedAt:100000,levels},tables};
 const clock=updateTournamentClock(match,180000);assert.equal(clock.autoPauseIndex,1);assert.equal(clock.pauseRequested,true);assert.equal(clock.pauseAt,undefined);
 assert.equal(blindAt(match.config,180000,clock).bigBlind,10,'prior blinds stay until admin resumes');
 assert.throws(()=>resumeTournamentClock(clock,180000),/动画/);
 tables[0].hand=null;tables[0].phase='idle';tables[0].startAt=185000;
 updateTournamentClock(match,184999);assert.equal(clock.pauseAt,undefined);
 updateTournamentClock(match,185000);assert.equal(clock.pauseAt,185000);assert.equal(clock.delayMs,25000);
 updateTournamentClock(match,999999);assert.equal(clock.pauseAt,185000);assert.equal(blindAt(match.config,999999,clock).bigBlind,10);
 resumeTournamentClock(clock,245000);assert.equal(clock.registrationDelayMs,60000);assert.equal(clock.completedPauseIndex,1);assert.equal(clock.autoPauseIndex,undefined);
 assert.equal(blindAt(match.config,245000,clock).bigBlind,20);
 updateTournamentClock(match,245000);assert.equal(clock.pauseRequested,false,'completed pause point must not trigger again');
 updateTournamentClock(match,305000);assert.equal(clock.autoPauseIndex,3,'the next pause point triggers independently');
 assert.throws(()=>normalizeTournamentLevels([levels[0],{type:2},{type:3,interval:20},levels.at(-1)]),/followed/);
});
test('a rest waits for all hands and animations, then gives the full duration despite a late tick',()=>{
  const tables=[{hand:{},phase:'playing',startAt:0,mtt:{}},{hand:null,phase:'idle',startAt:0,mtt:{paused:true}}];
  const match={config:{startedAt:100000,levels:plan()},tables};
  const clock=updateTournamentClock(match,180000);assert.equal(clock.waitingIndex,1);assert.equal(clock.restUntil,undefined);
  assert.equal(tables[0].mtt.clock,tables[1].mtt.clock);
  tables[0].hand=null;tables[0].phase='idle';tables[0].startAt=185000;
  updateTournamentClock(match,184999);assert.equal(clock.restUntil,undefined);
  updateTournamentClock(match,185000);assert.equal(clock.restUntil,195000);assert.equal(clock.delayMs,25000);
  assert.equal(tournamentRestSeconds(clock,185000),10);assert.ok(tables.every(t=>t.mtt.paused));
  assert.equal(blindAt(match.config,190000,clock).resting,true);
  updateTournamentClock(match,195000);assert.equal(clock.waitingIndex,undefined);assert.equal(clock.completedRestIndex,1);
  assert.equal(blindAt(match.config,195000,clock).bigBlind,20);
  updateTournamentClock(match,200000);assert.equal(clock.restUntil,undefined,'completed rest cannot replay');
});
