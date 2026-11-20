import {importHotModule} from "../../../shared/hot-import.js";
import test from 'node:test';
import assert from 'node:assert/strict';
const {createGameRouteIndex,bindRoundGameRoute,loadGameRoutes}=await importHotModule(new URL("../../../shared/rpc/game-routes.js",import.meta.url).href,"financial-route-selected-tests");
const row=(gameType,roomType,number,symbol)=>({gameType,roomType,number,symbol,state:1,isFrozen:0});

test('client pairs map to financial numbers independently from catalogue IDs and room modes',()=>{
  const index=createGameRouteIndex([row(19,19,91001,'test_holdem'),row(1000,50,91002,'test_hundred_holdem'),
    row(1004,61,91003,'test_scratch_mj'),row(1004,63,91004,'test_scratch_queen')]);
  assert.equal(index.resolve(19,19).number,91001);
  assert.equal(index.resolve(1004,61).number,91003);
  assert.equal(index.resolve(1004,63).number,91004);
  assert.throws(()=>index.resolve(1000,19),error=>error.code==='GAME_ROUTE_MISSING');
  assert.throws(()=>{index.resolve(19,19).number=19;},TypeError);
});

test('ambiguous numbers, duplicate pairs and malformed mappings fail before any financial call',()=>{
  const first=row(19,19,91001,'test_holdem');
  for(const records of [[first,{...first,number:91002}],[first,row(1000,50,91001,'test_other')],
    [{...first,roomType:0}],[{...first,number:NaN}],[{...first,symbol:''}],[{...first,state:undefined}],
    [{...first,roomType:true}],[{...first,number:'9e4'}],[first,row(1000,50,91002,'test_holdem')]]){
    assert.throws(()=>createGameRouteIndex(records),error=>error.code==='GAME_ROUTE_INVALID');
  }
  const frozen=createGameRouteIndex([{...first,isFrozen:1}]);
  assert.throws(()=>frozen.resolve(19,19),error=>error.code==='GAME_FROZEN');
});

test('replacing the route snapshot cannot mutate an already-bound round route',()=>{
  const config={game_type:19,room_type:19},round={};
  const old=createGameRouteIndex([row(19,19,91001,'test_old')]);
  const next=createGameRouteIndex([row(19,19,91002,'test_new')]);
  assert.equal(bindRoundGameRoute(round,old,config).number,91001);
  assert.equal(bindRoundGameRoute(round,next,config).number,91001);
  assert.equal(bindRoundGameRoute({},next,config).number,91002);
  assert.throws(()=>bindRoundGameRoute(round,next,{...config,room_type:50}),/different game/);
});

test('production loads the trusted catalogue once and dev performs no external lookup',async()=>{
  let calls=0;const rpc={lobby:{async listFinanceGames(){calls++;return [row(19,19,91001,'test_holdem')];}}};
  assert.equal(await loadGameRoutes({env:'dev',rpc}),null);assert.equal(calls,0);
  const index=await loadGameRoutes({env:'prod',rpc});assert.equal(index.resolve(19,19).number,91001);
  assert.equal(index.resolve(19,19).number,91001);assert.equal(calls,1);
  await assert.rejects(()=>loadGameRoutes({env:'prod',rpc:{lobby:{}}}),/unavailable/);
});
