import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

test('content loader reuses unchanged modules, reloads static dependencies, preserves residents and handles cycles',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-content-loader-'));
  try{
    fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
    fs.writeFileSync(path.join(root,'resident.js'),'export const value={keep:1};');
    fs.writeFileSync(path.join(root,'b.js'),'export const value=1;');
    fs.writeFileSync(path.join(root,'c.js'),'export const stable={id:1};');
    fs.writeFileSync(path.join(root,'cycle1.js'),"export {other} from './cycle2.js';export const own=1;");
    fs.writeFileSync(path.join(root,'cycle2.js'),"export {own} from './cycle1.js';export const other=2;");
    fs.writeFileSync(path.join(root,'a.js'),"export {value} from './b.js';export {stable} from './c.js';export {value as resident} from './resident.js';");
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';",
      'import {createHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const root='+JSON.stringify(root)+';',
      'const resolver=createHotResolver({directories:[root],residentFiles:[root+"/resident.js"],mode:()=>"test"});registerHooks({resolve:resolver.resolve});',
      'const url='+JSON.stringify(pathToFileURL(path.join(root,'a.js')).href)+';',
      'const first=await import(url+"?v=1");for(let n=2;n<80;n++){const next=await import(url+"?v="+n);assert.equal(next,first);assert.equal(next.stable,first.stable);}',
      'fs.writeFileSync(root+"/b.js","export const value=222;");const changed=await import(url+"?v=80");assert.equal(changed.value,222);assert.notEqual(changed,first);assert.equal(changed.stable,first.stable);assert.equal(changed.resident,first.resident);',
      'const cycle=await import('+JSON.stringify(pathToFileURL(path.join(root,'cycle1.js')).href)+'+"?v=81");assert.equal(cycle.other,2);',
      'assert.ok(resolver.stats().recentTokens<=64);console.log("PASS_CONTENT_RELOAD");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_CONTENT_RELOAD/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('canonical legacy rel imports reuse namespaces and keep already-running handler dependencies after a real edit',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-import-test-',import.meta.url));
  try{
    fs.writeFileSync(path.join(root,'a.js'),"import {rel} from '../../game-server/src/rel.js';export const own={};export function child(v){return rel(import.meta.url,'./b.js',v);}");
    fs.writeFileSync(path.join(root,'b.js'),'export const value=1;');
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {importHotModule} from '+JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href)+';',
      'const url='+JSON.stringify(pathToFileURL(path.join(root,'a.js')).href)+';',
      'const first=await importHotModule(url,"first"),child=await first.child("first");',
      'for(let n=0;n<128;n++)assert.equal(await first.child("repeat-"+n),child);',
      'fs.writeFileSync('+JSON.stringify(path.join(root,'b.js'))+',"export const value=222;");',
      'const next=await importHotModule(url,"changed");assert.notEqual(next,first);assert.equal((await next.child("changed")).value,222);',
      'assert.equal((await first.child("old-task-resumes")).value,1);console.log("PASS_CANONICAL_LINKS");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_CANONICAL_LINKS/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('watchHot reuses an unchanged entry and keeps the previous module when a new source fails to compile',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-watch-test-',import.meta.url));
  try{
    const entry=path.join(root,'entry.js');fs.writeFileSync(entry,'export const token={value:1};');
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {watchHot} from '+JSON.stringify(new URL('../../game-server/src/hot.js',import.meta.url).href)+';',
      'const entry='+JSON.stringify(entry)+',mods=[],errors=[];',
      'const reload=watchHot({dir:'+JSON.stringify(root)+',entry,onReload:async m=>mods.push(m),log:{error:e=>errors.push(String(e))}});',
      'await reload("first");await reload("same");assert.equal(mods[0],mods[1]);',
      'fs.writeFileSync(entry,"export const =;");await reload("broken");assert.equal(mods.length,2);assert.equal(errors.length,1);',
      'fs.writeFileSync(entry,"export const token={value:222};");await reload("fixed");assert.equal(mods.at(-1).token.value,222);assert.equal(mods[0].token.value,1);',
      'console.log("PASS_HOT_WATCHER");process.exit(0);',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_HOT_WATCHER/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
