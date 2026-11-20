import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {createPlayerPanel}=await importHotModule(new URL('../../game-server/src/core/player-panel.js',import.meta.url).href,'player-service-regression');
const {playerPanelPersistedRecords}=await importHotModule(new URL('../../shared/player-panel.js',import.meta.url).href,'player-service-regression');

const types=[24,25,26,27,28,30,31,32];
function fixture(roomType){
  const calls=[],now=Date.now(),runtime={env:'prod',gateway:{
    async playerPanel(action,input){calls.push({action,input});return action==='noteGet'?{}:{records:[],complete:false,statistics:{totalHands:25001,effectiveBetHands:20000,effectiveBetHandPercent:80,netWinHands:10000,winPercent:40}};},
    async getUserCenter(query){return {records:[],total:query.startTime===undefined?0:12,totalScore:123,paged:true};},
  }};
  const table={agentId:7,roomId:123,roomType,gameId:'native',members:[{uid:42,name:'Owner'},{uid:43,name:'Target'}]};
  const session={agentId:7,userId:42,currency:'CNY',authenticated:true,inRoom:true,roomId:123,gameId:'native'};
  return {runtime,table,session,calls,now};
}

test('all native seat games persist only real statistical facts and omit cards, profiles and actions',()=>{
  for(const roomType of types){
    const row={id:'same-id',agentId:7,userId:42,currency:'CNY',roomType,roomId:123,inning:1,endedAt:Date.now(),net:-20,effectiveBet:20,
      balance:9999,players:[{uid:42,handCards:[1,2],wallet:9999}],detail:{firstGameList:[{uid:42,handPais:[1,2],operateList:[{operate:9}]}],
        secret:'private-card-data',commonCards:[40,41,42]}};
    const result=playerPanelPersistedRecords([row,{...row,userId:90000001},{...row,replayOnly:true},{...row,userId:42.5},{...row,roomType:101},{...row,roomType:58}]);
    assert.equal(result.length,1);assert.equal(result[0].roomType,roomType);assert.equal(result[0].net,-20);
    assert.deepEqual(result[0].players,[]);assert.equal(result[0].countersKnown,false);
    for(const key of ['balance','detail','commonCards','events'])assert.equal(result[0][key],undefined);
    assert.ok(!JSON.stringify(result).includes('private-card-data'));
  }
});

test('native real profiles read lifetime counts for the exact room type while keeping recent scores on ES history',async()=>{
  for(const roomType of types){
    const {runtime,table,session,calls}=fixture(roomType),panel=await createPlayerPanel(runtime);
    const profile=await panel.profile(session,table,43);
    assert.equal(profile.totalHands,25001);assert.equal(profile.oneWeekHands,12);assert.equal(profile.todayScore,123);
    assert.equal(profile.effectiveBetHands,20000);assert.equal(profile.effectiveBetHandPercent,80);
    assert.equal(profile.netWinHands,10000);assert.equal(profile.winPercent,40);
    assert.equal(profile.joinPercent,'--');assert.equal(profile.flipManualBetPercent,'--');
    assert.equal(profile.name,'Target');assert.equal(profile.isRobot,undefined);
    assert.deepEqual(calls.find(c=>c.action==='read').input,{agentId:7,userId:42,targetId:43,currency:'CNY',roomId:123,roomType});
  }
});

test('native lifetime count failures and malformed counts cannot become synthetic or truncated totals',async()=>{
  for(const total of [undefined,-1,1.5,'20',Number.MAX_SAFE_INTEGER+1]){
    const {runtime,table,session}=fixture(25);
    runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands:total,effectiveBetHands:0,effectiveBetHandPercent:0}};
    const panel=await createPlayerPanel(runtime);
    await assert.rejects(panel.profile(session,table,43),{status:503});
  }
  const {runtime,table,session}=fixture(25);
  runtime.gateway.playerPanel=async action=>{if(action==='noteGet')return {};throw Object.assign(new Error('storage unavailable'),{status:503});};
  const panel=await createPlayerPanel(runtime);await assert.rejects(panel.profile(session,table,43),{status:503});
});

test('native profile total zero is a valid empty saved history',async()=>{
  const {runtime,table,session}=fixture(24);
  runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands:0,effectiveBetHands:0,effectiveBetHandPercent:0}};
  const panel=await createPlayerPanel(runtime);assert.equal((await panel.profile(session,table,43)).totalHands,0);
});

test('native effective bet counts remain separate from voluntary betting and validate every aggregate',async()=>{
  for(const patch of [
    {effectiveBetHands:-1,effectiveBetHandPercent:0},
    {effectiveBetHands:25002,effectiveBetHandPercent:100},
    {effectiveBetHands:1.5,effectiveBetHandPercent:0},
    {effectiveBetHands:'20000',effectiveBetHandPercent:80},
    {effectiveBetHands:20000,effectiveBetHandPercent:NaN},
    {effectiveBetHands:20000,effectiveBetHandPercent:Infinity},
    {effectiveBetHands:20000,effectiveBetHandPercent:101},
    {effectiveBetHands:20000,effectiveBetHandPercent:79},
    {effectiveBetHands:20000},
    {effectiveBetHandPercent:80},
  ]){
    const {runtime,table,session}=fixture(24);
    runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands:25001,...patch}};
    const panel=await createPlayerPanel(runtime);
    await assert.rejects(panel.profile(session,table,43),{status:503});
  }
});

test('an older backend that returns only total hands continues to serve the real profile',async()=>{
  const {runtime,table,session}=fixture(24);
  runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands:10}};
  const panel=await createPlayerPanel(runtime),profile=await panel.profile(session,table,43);
  assert.equal(profile.totalHands,10);
  assert.equal(profile.effectiveBetHands,undefined);
  assert.equal(profile.effectiveBetHandPercent,undefined);
  assert.equal(profile.netWinHands,undefined);assert.equal(profile.winPercent,undefined);
  assert.equal(profile.joinPercent,'--');
  assert.equal(profile.flipManualBetPercent,'--');
});

test('native winning hand statistics reject invalid counts and inconsistent percentages',async()=>{
  for(const patch of [
    {netWinHands:-1,winPercent:0}, {netWinHands:25002,winPercent:100},
    {netWinHands:2.5,winPercent:0}, {netWinHands:'10000',winPercent:40},
    {netWinHands:10000,winPercent:Infinity}, {netWinHands:10000,winPercent:NaN},
    {netWinHands:10000,winPercent:101}, {netWinHands:10000,winPercent:41},
    {netWinHands:10000}, {winPercent:40},
  ]){
    const {runtime,table,session}=fixture(25);
    runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands:25001,...patch}};
    const panel=await createPlayerPanel(runtime);
    await assert.rejects(panel.profile(session,table,43),{status:503});
  }
});

test('net zero hands stay in the win rate denominator and zero saved results stay empty',async()=>{
  for(const [totalHands,netWinHands,winPercent]of [[3,1,33.33],[10,0,0],[0,0,0],[10,10,100]]){
    const {runtime,table,session}=fixture(25);
    runtime.gateway.playerPanel=async action=>action==='noteGet'?{}:{statistics:{totalHands,netWinHands,winPercent}};
    const panel=await createPlayerPanel(runtime),profile=await panel.profile(session,table,43);
    assert.equal(profile.netWinHands,netWinHands);assert.equal(profile.winPercent,winPercent);
    assert.equal(profile.joinPercent,'--');assert.equal(profile.flipManualBetPercent,'--');
  }
});
