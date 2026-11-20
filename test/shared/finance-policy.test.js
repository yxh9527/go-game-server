import test from 'node:test';
import assert from 'node:assert/strict';
import {CASH_FINANCE_ROOM_TYPES,productionFinanceConfig,validateProductionFinance} from '../../shared/finance-policy.js';
import {loadGames} from '../../game-server/src/games/catalog.js';

test('production finance configuration covers every registered cash game and preserves the scratch authority boundary',async()=>{
  const games=await loadGames('finance-policy');
  const actual=new Set(games.list.filter(game=>game.kind!=='slots').flatMap(game=>game.roomTypes).filter(type=>type!==101));
  assert.deepEqual([...actual].sort((a,b)=>a-b),[...CASH_FINANCE_ROOM_TYPES]);
  const prior={provider:'legacy',room_types:[53],banker_net:true},config=productionFinanceConfig(prior);
  assert.equal(config.provider,'lottery');assert.equal(config.banker_net,true);validateProductionFinance({finance:config});
  assert.deepEqual(prior.room_types,[53]);assert.equal(config.room_types.includes(61),false);assert.equal(config.room_types.includes(101),false);
  assert.throws(()=>validateProductionFinance({}),/生产现金游戏/);
  assert.throws(()=>validateProductionFinance({finance:{provider:'lottery',room_types:[53]}}),/生产现金游戏/);
  assert.throws(()=>validateProductionFinance({finance:{...config,room_types:[...config.room_types,101]}}),/生产现金游戏/);
});
