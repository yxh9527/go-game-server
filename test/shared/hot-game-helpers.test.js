import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createCollectibleEntryLoader,collectibleGameHelperFiles,collectibleModuleFiles} from '../../shared/hot-entry-factory.js';

test('reviewed helper whitelist includes 26 card, rule and strategy modules without resident financial state',()=>{
  assert.equal(collectibleGameHelperFiles.length,26);assert.equal(collectibleModuleFiles.length,242);
  assert.equal(new Set(collectibleModuleFiles).size,242);const loader=createCollectibleEntryLoader();
  for(const file of collectibleGameHelperFiles){assert.ok(fs.existsSync(file));assert.equal(loader.handles(pathToFileURL(file).href),true);}
  for(const file of ['../../shared/rpc/index.js','../../shared/session-revocation-listener.js','../../shared/rpc/env.js'])assert.equal(loader.handles(new URL(file,import.meta.url).href),false);
});

test('real card helper changes propagate through the engine and handler while old calls and funded rooms stay intact',()=>{
  const output='cache/hot-helper-graph-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs','--loader=collectible','--entry=helper','--revisions=26','--clients=4','--sample-every=13','--output='+output],{
      cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true,
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(new URL('../../'+output,import.meta.url),'utf8'));
    assert.equal(report.helperChanges,26);assert.equal(report.successfulChanges,26);assert.equal(report.residentRoomChecks,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.preservedGameInstances,20);assert.equal(report.requests,112);assert.equal(report.remainingSessions,0);assert.equal(report.remainingTables,0);assert.deepEqual(report.errors,[]);
  }finally{fs.rmSync(new URL('../../'+output,import.meta.url),{force:true});}
});

test('released real helpers, bounded rank caches, strategy weak maps and engine imports can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-game-helpers.mjs'],{
    cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:60000,windowsHide:true,
  });
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_HELPERS_GC/);
});
