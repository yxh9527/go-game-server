import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {importHotModule} from '../../shared/hot-import.js';
import {collectibleGameEntryFiles,collectibleGameClassFiles,collectibleGameBaseFiles,collectibleGameEngineFiles,collectibleGameHelperFiles,collectibleHistoryFiles,collectibleRuleFiles,collectibleCoreHelperFiles,collectibleFinanceHelperFiles,collectibleFinanceControllerFiles,collectibleWalletFacadeFiles,collectibleRoomRuntimeFiles,collectiblePlayerServiceFiles,collectibleTournamentFiles} from '../../shared/hot-entry-factory.js';
import {seedRooms} from '../../cache/rpc/seed.js';

// The hall-only shared/game-history-detail reader stays lazy in these isolated
// game-handler loads; count the other reviewed history modules at startup.
// The native ticket adapter similarly retains the initial slots-reels import;
// independent reel factories are exercised by dedicated and production tests.

test('collectible game catalog matches native routing and reuses all unchanged default game instances',async()=>{
  const location=new URL('../../game-server/src/games/catalog.js',import.meta.url).href;
  const catalog=await importHotModule(location,'catalog-first'),native=await import(location);
  const first=await catalog.loadGames('catalog-first');
  const next=await catalog.loadGames('catalog-again'),reference=await native.loadGames('catalog-native');
  assert.equal(first.list.length,21);assert.equal(collectibleGameEntryFiles.length,22);
  assert.equal(new Set(first.list.map(game=>game.id)).size,21);
  assert.ok(first.list.every(game=>game.id!=='luck5'));
  assert.deepEqual([...first.byRoomType.keys()],[...reference.byRoomType.keys()]);
  for(let index=0;index<first.list.length;index++){
    const game=first.list[index];
    assert.equal(game,next.list[index]);assert.equal(game,reference.list[index]);
    for(const roomType of game.roomTypes)assert.equal(catalog.gameOf(first,roomType),game);
  }
  assert.equal(catalog.gameOf(first,19),catalog.gameOf(first,101));
  assert.equal(catalog.gameOf(first,999999),null);
  assert.equal(await importHotModule(location,'catalog-unchanged'),catalog);
});

test('all collectible concrete games create rooms and client configuration like the original classes',async()=>{
  const location=new URL('../../game-server/src/games/catalog.js',import.meta.url).href;
  const catalog=await importHotModule(location,'concrete-room-parity'),games=await catalog.loadGames('concrete-room-parity');
  const references=new Map();let Turntable;
  for(const file of collectibleGameClassFiles){
    const module=await import(pathToFileURL(file).href);
    if(module.default)references.set(module.default.id,module.default);else Turntable=module.TurntableGame;
  }
  const rows=seedRooms();
  for(const game of games.list){
    const roomType=game.roomTypes[0];
    const row=rows.find(row=>Number(row.room_type)===roomType&&Number(row.play_mode||0)===0)||rows.find(row=>Number(row.room_type)===roomType);
    assert.ok(row,'missing room fixture for '+game.id);
    const roomId=Number(row.game_room_config_id)*10000+Number(row.room_index||0);
    const reference=references.get(game.id)||new Turntable(game.config);
    const table=game.createTable(roomId,roomType,row),original=reference.createTable(roomId,roomType,row);
    assert.equal(table.gameId,game.id);assert.equal(table.roomType,roomType);assert.equal(table.roomId,roomId);
    assert.equal(table.config,game.config);
    assert.deepEqual(game.buildConf(table),reference.buildConf(original),game.id);
  }
});

test('real catalog edits preserve game instances, resident room state and live heartbeats',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/hot-catalog-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--loader=collectible','--entry=catalog','--revisions=26','--clients=4','--sample-every=13','--output='+output],
    {cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.successfulChanges,26);assert.equal(report.failedCompileAttempts,1);assert.equal(report.requests,112);
    assert.equal(report.residentRoomChecks,26);assert.equal(report.preservedGameInstances,21);
    assert.equal(report.remainingSessions,0);assert.equal(report.remainingTables,0);assert.deepEqual(report.errors,[]);
    assert.ok(report.samples.every(row=>row.factories.activeEntries===24+collectibleGameClassFiles.length+collectibleGameBaseFiles.length+collectibleGameEngineFiles.length+collectibleGameHelperFiles.length+collectibleHistoryFiles.length-1+collectibleRuleFiles.length+collectibleCoreHelperFiles.length-1+collectibleFinanceHelperFiles.length-1+collectibleFinanceControllerFiles.length-1+collectibleWalletFacadeFiles.length+collectibleRoomRuntimeFiles.length+collectiblePlayerServiceFiles.length-1+collectibleTournamentFiles.length-1+41/* reviewed config/protocol and control dependencies; lazy tools excluded */&&row.factories.pendingEntries===0&&row.factories.dependencyWaits===0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});

test('real concrete class edits replace its behavior while preserving the room, hand and other games',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/hot-concrete-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--loader=collectible','--entry=class','--revisions=26','--clients=4','--sample-every=13','--output='+output],
    {cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.successfulChanges,26);assert.equal(report.concreteClassChanges,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.residentRoomChecks,26);assert.equal(report.preservedGameInstances,20);assert.equal(report.requests,112);
    assert.equal(report.remainingSessions,0);assert.equal(report.remainingTables,0);assert.deepEqual(report.errors,[]);
    assert.ok(report.samples.every(row=>row.factories.activeEntries===65+collectibleGameHelperFiles.length+collectibleHistoryFiles.length-1+collectibleRuleFiles.length+collectibleCoreHelperFiles.length-1+collectibleFinanceHelperFiles.length-1+collectibleFinanceControllerFiles.length-1+collectibleWalletFacadeFiles.length+collectibleRoomRuntimeFiles.length+collectiblePlayerServiceFiles.length-1+collectibleTournamentFiles.length-1+41/* reviewed config/protocol and control dependencies; lazy tools excluded */&&row.factories.pendingEntries===0&&row.factories.dependencyWaits===0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});

test('real engine edits change client configuration through the game while retaining resident hand state',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/hot-engine-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--loader=collectible','--entry=engine','--revisions=26','--clients=4','--sample-every=13','--output='+output],
    {cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.successfulChanges,26);assert.equal(report.engineChanges,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.residentRoomChecks,26);assert.equal(report.preservedGameInstances,20);assert.equal(report.requests,112);
    assert.equal(report.remainingSessions,0);assert.equal(report.remainingTables,0);assert.deepEqual(report.errors,[]);
    assert.ok(report.samples.every(row=>row.factories.activeEntries===65+collectibleGameHelperFiles.length+collectibleHistoryFiles.length-1+collectibleRuleFiles.length+collectibleCoreHelperFiles.length-1+collectibleFinanceHelperFiles.length-1+collectibleFinanceControllerFiles.length-1+collectibleWalletFacadeFiles.length+collectibleRoomRuntimeFiles.length+collectiblePlayerServiceFiles.length-1+collectibleTournamentFiles.length-1+41/* reviewed config/protocol and control dependencies; lazy tools excluded */&&row.factories.pendingEntries===0&&row.factories.dependencyWaits===0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});
