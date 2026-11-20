import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {collectibleModuleFiles} from '../../shared/hot-entry-factory.js';
import {residentModuleFiles} from '../../shared/hot-loader.js';
import {remainingBusinessFixture} from '../fixtures/hot-remaining-business.mjs';

test('every production JavaScript module is classified as a business factory or a resident owner',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url)),selected=new Set(collectibleModuleFiles.map(file=>path.resolve(file).toLowerCase())),resident=new Set(residentModuleFiles),missing=[];
  for(const file of selected)assert.equal(resident.has(file),false,'business factory is also a resident: '+file);
  for(const directory of ['game-server/src','hall/src','match/src','client-web/src','shared']){
    for(const name of fs.readdirSync(path.join(root,directory),{recursive:true}).filter(file=>file.endsWith('.js'))){
      const file=path.resolve(root,directory,name).toLowerCase();if(!selected.has(file)&&!resident.has(file))missing.push(path.relative(root,file));
    }
  }
  assert.deepEqual(missing,[],'new business modules need an explicit hot-loading/ownership decision');
});

test('edited game configuration and protocol constants are isolated from retained old callers',async()=>{
  const f=remainingBusinessFixture();
  try{
    f.write(0);const old=(await f.load('holdem/config.js',0)).default,op=await f.load('holdem/op.js',0);
    const config=f.sources.find(item=>item.file.replaceAll('\\','/').endsWith('/holdem/config.js'));assert.ok(config.source.includes('betTime: 11'));config.source=config.source.replace('betTime: 11','betTime: 13');
    f.write(1);const next=(await f.load('holdem/config.js',1)).default,nextOp=await f.load('holdem/op.js',1);
    assert.equal(old.betTime,11);assert.equal(next.betTime,13);assert.deepEqual(next.roomTypes,old.roomTypes);assert.deepEqual(nextOp.OP,op.OP);
  }finally{f.close();}
});

test('remaining game configs, protocol exports and compatibility helpers can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-remaining-business.mjs','--remaining-business-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REMAINING_BUSINESS_GC/);
});
