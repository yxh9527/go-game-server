import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHotResolver} from '../../shared/hot-loader.js';

test('shared and missing dependencies are probed once per validation epoch and rechecked on the next reload',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-presence-',import.meta.url));
  const originalExists=fs.existsSync,probes=new Map();
  try{
    const entry=path.join(root,'entry.js'),other=path.join(root,'other.js'),leaf=path.join(root,'leaf.js'),optional=path.join(root,'optional.js');
    fs.writeFileSync(entry,"import './leaf.js';import './leaf.js';export const optional='./optional.js';");
    fs.writeFileSync(other,"import './leaf.js';import './leaf.js';export const optional='./optional.js';");
    fs.writeFileSync(leaf,'export const value=1;');
    const resolver=createHotResolver({directories:[root],residentFiles:[],mode:()=> 'test'});
    fs.existsSync=function(file,...args){if(path.dirname(String(file))===root)probes.set(String(file),(probes.get(String(file))||0)+1);return Reflect.apply(originalExists,this,[file,...args]);};
    const resolve=(file,token,parent)=>{
      const url=pathToFileURL(file);if(token)url.searchParams.set('v',token);
      return resolver.resolve(url.href,{parentURL:parent},value=>({url:value})).url;
    };
    const first=resolve(entry,'initial');resolve(other,null,first);
    assert.equal(probes.get(leaf),1,'shared/repeated paths caused duplicate disk probes');
    assert.equal(probes.get(optional),1,'missing paths caused duplicate disk probes');
    assert.equal(resolver.readSource(first),fs.readFileSync(entry,'utf8'));
    assert.equal(probes.get(leaf),2,'source verification must start a fresh validation epoch');
    fs.writeFileSync(optional,'export const available=true;');
    const added=resolve(entry,'created');assert.notEqual(added,first);
    fs.rmSync(optional);assert.notEqual(resolve(entry,'removed'),added);
    const before=probes.get(leaf);resolver.invalidate();resolve(entry,'removed');
    assert.equal(probes.get(leaf),before+1,'explicit invalidation retained stale presence data');
  }finally{fs.existsSync=originalExists;fs.rmSync(root,{recursive:true,force:true});}
});

test('path presence cache remains bounded and is cleared when environment mode changes',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-presence-bound-',import.meta.url));
  try{
    const entry=path.join(root,'entry.js');let mode='dev';
    fs.writeFileSync(entry,'export const paths='+JSON.stringify(Array.from({length:5000},(_,index)=>'./missing-'+index+'.js'))+';');
    const resolver=createHotResolver({directories:[root],residentFiles:[],mode:()=>mode});
    const resolve=()=>resolver.resolve(pathToFileURL(entry).href+'?v=same',{},value=>({url:value})).url;
    const initial=resolve(),first=resolver.stats();
    assert.equal(first.maxPresenceEntries,4096);assert.ok(first.presenceEntries>0&&first.presenceEntries<=first.maxPresenceEntries);
    mode='prod';fs.writeFileSync(entry,'export const value=1;');
    assert.notEqual(resolve(),initial);assert.equal(resolver.stats().presenceEntries,0);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resident modules discard loader-only parameters and retain their original namespace',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-resident-link-',import.meta.url));
  try{
    const resident=path.join(root,'resident.js');fs.writeFileSync(resident,'export const state={};');
    const resolver=createHotResolver({directories:[root],residentFiles:[resident],mode:()=> 'test'});
    const original=pathToFileURL(resident).href;
    const resolved=resolver.resolve(original+'?v=hot-old&link=2&_hot_source=1',{},value=>({url:value})).url;
    assert.equal(resolved,original,'resident import forked due to a loader link');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

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

test('hot source pins literal rel dependencies without retaining a global version map',async()=>{
  const {pinHotSource}=await import('../../shared/hot-source-pins.js');
  const source="import {rel} from './rel.js'; export const child=()=>rel(import.meta.url,'./hot-import.js',version);";
  const resolver={resolve:specifier=>({url:specifier})};
  const pinned=pinHotSource(source,'file:///D:/project/gogame/shared/hot-source-pins.js?v=hot-version',resolver);
  assert.equal(pinned.dynamic,0);
  assert.equal(pinned.pinned,1);
  assert.match(pinned.source,/import\("file:\/\/\/D:\/project\/gogame\/shared\/hot-import\.js\?v=hot-version/);
});

test('pinned literal dependencies preserve argument evaluation, exceptions and already-running version links',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-pin-evaluation-',import.meta.url));
  try{
    fs.writeFileSync(path.join(root,'child.js'),'export const value=1;');
    fs.writeFileSync(path.join(root,'entry.js'),[
      "import {rel} from '../../shared/hot-import.js';",
      'export const events=[];',
      "export const load=()=>rel(import.meta.url,'./child.js',(events.push('version'),17),(events.push('extra'),23));",
      "export const fail=()=>rel(import.meta.url,'./child.js',(()=>{throw Error('original-argument-failure')})());",
      "export const asyncLoad=async()=>rel(import.meta.url,'./child.js',await Promise.resolve().then(()=>{events.push('awaited');return 18}));",
    ].join('\n'));
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {installHotSourcePins} from '+JSON.stringify(new URL('../../shared/hot-source-pins.js',import.meta.url).href)+';',
      'import {importHotModule} from '+JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href)+';',
      'installHotSourcePins();const entry='+JSON.stringify(pathToFileURL(path.join(root,'entry.js')).href)+';',
      'const original=await importHotModule(entry,"original");assert.equal((await original.load()).value,1);assert.deepEqual(original.events,["version","extra"]);',
      'assert.throws(()=>original.fail(),/original-argument-failure/);assert.equal((await original.asyncLoad()).value,1);assert.deepEqual(original.events,["version","extra","awaited"]);',
      'fs.writeFileSync('+JSON.stringify(path.join(root,'child.js'))+',"export const value=222;");',
      'const updated=await importHotModule(entry,"updated");assert.equal((await updated.load()).value,222);',
      'assert.equal((await original.load()).value,1);assert.deepEqual(original.events,["version","extra","awaited","version","extra"]);',
      'console.log("PASS_PIN_ARGUMENTS");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_PIN_ARGUMENTS/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('source pins leave locally shadowed rel functions, strings and comments untouched',async()=>{
  const {pinHotSource}=await import('../../shared/hot-source-pins.js');
  const source=[
    "import {rel} from './hot-import.js';",
    "export const pin=()=>rel(import.meta.url,'./hot-import.js',1);",
    "export const parameter=(rel)=>rel(import.meta.url,'./hot-import.js',2);",
    "export function hoisted(){return rel(import.meta.url,'./hot-import.js',3);var rel;}",
    "export function block(){const rel=()=>4;return rel(import.meta.url,'./hot-import.js',4);}",
    "export function caught(){try{}catch(rel){return rel(import.meta.url,'./hot-import.js',5);}}",
    "export const namedClass=class rel {static call(){return rel(import.meta.url,'./hot-import.js',6);}};",
    "export function switched(value){switch(value){case 0:const rel=()=>7;return rel(import.meta.url,'./hot-import.js',7);}}",
    "export function loop(){for(const rel of []){rel(import.meta.url,'./hot-import.js',8);}}",
    "export const patch=\"rel(import.meta.url,'./hot-import.js',9)\";",
    "// rel(import.meta.url,'./hot-import.js',10)",
  ].join('\n');
  const location=new URL('../../shared/hot-source-pins.js?v=hot-scope-test',import.meta.url).href;
  const result=pinHotSource(source,location,{resolve:specifier=>({url:specifier})});
  assert.equal(result.pinned,1);assert.equal(result.dynamic,0);
  assert.ok(result.source.includes('import("file:'));
  for(const line of source.split('\n').slice(2))assert.ok(result.source.includes(line),line);
});

test('dynamic source pins preserve hashbangs and pin each literal dependency for an old lazy caller',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-pin-dynamic-',import.meta.url));
  try{
    fs.writeFileSync(path.join(root,'child.js'),'export const value=1;');
    fs.writeFileSync(path.join(root,'entry.js'),[
      '#!/usr/bin/env node',
      "import {rel} from '../../shared/hot-import.js';",
      "const paths=['./child.js'];export let count=0;",
      'export const lazy=()=>rel(import.meta.url,paths[0],++count);',
    ].join('\n'));
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {installHotSourcePins} from '+JSON.stringify(new URL('../../shared/hot-source-pins.js',import.meta.url).href)+';',
      'import {importHotModule} from '+JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href)+';',
      'installHotSourcePins();const entry='+JSON.stringify(pathToFileURL(path.join(root,'entry.js')).href)+';',
      'const old=await importHotModule(entry,"old-lazy-version");',
      'assert.equal((await old.lazy()).value,1);assert.equal(old.count,1);',
      'fs.writeFileSync('+JSON.stringify(path.join(root,'child.js'))+',"export const value=222;");',
      'const next=await importHotModule(entry,"next-lazy-version");assert.equal((await next.lazy()).value,222);',
      'assert.equal((await old.lazy()).value,1);assert.equal(old.count,2);console.log("PASS_DYNAMIC_PINS");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_DYNAMIC_PINS/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('hot import diagnostics expose independent numeric counters without retaining module namespaces',async()=>{
  const {hotImportStats}=await import('../../shared/hot-import.js');
  const first=hotImportStats();
  assert.deepEqual(Object.keys(first).sort(),['dependencyLinks','linkedParents','maxLinkedParents','maxPresenceEntries','presenceEntries','recentTokens','sourceFiles','versionEntries']);
  for(const value of Object.values(first))assert.ok(Number.isSafeInteger(value)&&value>=0);
  assert.ok(first.linkedParents<=first.maxLinkedParents);
  assert.ok(first.presenceEntries<=first.maxPresenceEntries);
  first.linkedParents=Number.MAX_SAFE_INTEGER;
  const second=hotImportStats();assert.notEqual(second.linkedParents,first.linkedParents);
});

test('real source-change load keeps live heartbeats, rejects bad edits and releases every isolated session',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/hot-source-load-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--revisions=26','--clients=4','--sample-every=13','--output='+output],{cwd:root,encoding:'utf8',timeout:30000});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.successfulChanges,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.requests,4*(1+26+1));assert.equal(report.remainingSessions,0);
    assert.deepEqual(report.errors,[]);assert.equal(report.samples.length,3);
    assert.ok(report.samples.every(row=>row.connections===4&&row.sessions===4));
    assert.ok(report.samples.every(row=>row.imports.linkedParents<=row.imports.maxLinkedParents));
    assert.ok(report.samples.every(row=>Number.isSafeInteger(row.heapBytes)&&row.heapBytes>0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});
