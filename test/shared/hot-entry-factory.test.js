import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createCollectibleEntryLoader,collectibleGameEntryFiles,collectibleGameClassFiles,collectibleGameBaseFiles,collectibleGameEngineFiles,collectibleGameHelperFiles,collectibleHistoryFiles,collectibleRuleFiles,collectibleCoreHelperFiles,collectibleFinanceHelperFiles,collectibleFinanceControllerFiles,collectibleWalletFacadeFiles,collectibleRoomRuntimeFiles,collectiblePlayerServiceFiles,collectibleTournamentFiles} from '../../shared/hot-entry-factory.js';
import {createHotResolver} from '../../shared/hot-loader.js';

// Shared game-history-detail is loaded lazily by hall requests, so these
// game-handler-only fixtures eagerly load one fewer history module.
// slots-reels is selected independently but still reached through the native
// ticket adapter at startup, so its factory is also lazy in these fixtures.

function fixture(){
  const root=fs.mkdtempSync(new URL('../../cache/collectible-entry-test-',import.meta.url));
  const entry=path.join(root,'entry.js'),child=path.join(root,'child.js');
  const resolver=createHotResolver({directories:[root],residentFiles:[],mode:()=> 'test'});
  const loader=createCollectibleEntryLoader({entries:[entry,child],resolver});
  let revision=0;
  return {root,entry,child,loader,resolver,location(file=entry){
    const url=pathToFileURL(file);url.searchParams.set('v','revision-'+ ++revision);
    return resolver.resolve(url.href,{},value=>({url:value})).url;
  },load(file=entry){
    return loader.load(this.location(file));
  },close(){fs.rmSync(root,{recursive:true,force:true});}};
}

test('collectible entries preserve live exports, static dependencies, old lazy callers and failed-edit rollback',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.child,'export const value=1;');
    fs.writeFileSync(f.entry,[
      "import * as child from './child.js';",
      "import {value as initial} from './child.js';",
      "export {value as forwarded} from './child.js';",
      'export let count=0;export const increment=()=>++count;',
      'export const snapshot=()=>[child.value,initial];',
      "export const lazy=()=>import('./child.js').then(module=>module.value);",
      "export const text=\"import('./untouched.js')\";",
    ].join('\n'));
    const old=await f.load();
    assert.equal(await f.load(),old);assert.equal(Object.getPrototypeOf(old),null);
    assert.equal(Object.prototype.toString.call(old),'[object Module]');
    assert.ok(Object.isFrozen(old));assert.throws(()=>{old.count=7;},TypeError);
    old.increment();assert.equal(old.count,1);assert.equal(old.forwarded,1);
    assert.deepEqual(old.snapshot(),[1,1]);assert.equal(await old.lazy(),1);
    fs.writeFileSync(f.child,'export const value=222;');
    const next=await f.load();assert.notEqual(next,old);
    assert.deepEqual(next.snapshot(),[222,222]);assert.equal(await next.lazy(),222);
    assert.equal(await old.lazy(),1);assert.deepEqual(old.snapshot(),[1,1]);
    assert.equal(next.count,0);assert.equal(old.count,1);
    fs.writeFileSync(f.entry,'export const broken=;');
    await assert.rejects(f.load(),SyntaxError);
    assert.equal(await old.lazy(),1);assert.equal(await next.lazy(),222);
    assert.equal(f.loader.stats().pendingEntries,0);
    assert.equal(f.loader.stats().activeEntries,2);
    assert.equal(f.loader.stats().compileFailures,1);
    assert.equal(old.text,"import('./untouched.js')");
  }finally{f.close();}
});

test('per-compilation scope preserves native globals, intrinsics and strict lexical behavior',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.entry,[
      'export const object=()=>({});export const map=()=>new Map();export const error=()=>new TypeError("native");',
      'export const globals=()=>[Object===globalThis.Object,Map===globalThis.Map,Promise===globalThis.Promise,Symbol===globalThis.Symbol];',
      'export const strictThis=(function(){return this})();',
      'export let value=1;export const increment=()=>++value;',
      'export const missing=()=>__gogameNoSuchGlobalBinding;',
    ].join('\n'));
    const first=await f.load();assert.equal(Object.getPrototypeOf(first.object()),Object.prototype);assert.ok(first.map() instanceof Map);assert.ok(first.error() instanceof TypeError);
    assert.deepEqual(first.globals(),[true,true,true,true]);assert.equal(first.strictThis,undefined);assert.throws(first.missing,ReferenceError);
    first.increment();assert.equal(first.value,2);
    fs.appendFileSync(f.entry,'\nexport const revision=2;');
    const next=await f.load();assert.notEqual(first,next);assert.equal(next.value,1);assert.equal(first.value,2);assert.deepEqual(next.globals(),[true,true,true,true]);
  }finally{f.close();}
});

test('default export values and named bindings match native modules, including anonymous names and initializers',async()=>{
  const cases=[
    ['export let local={id:1};export default local;export const change=()=>{local={id:2}};',module=>{const before=module.default;module.change();return [module.default.id,module.local.id,before===module.default];}],
    ['export let local={id:1};export {local as default};export const change=()=>{local={id:2}};',module=>{const before=module.default;module.change();return [module.default.id,module.local.id,before===module.default];}],
    ['export default function sample(){return 1};export const change=()=>{sample=()=>2};',module=>{const before=module.default;module.change();return [before.name,before(),module.default()];}],
    ['export default class Sample {static value=1};export const change=()=>{Sample=class Replacement {static value=2}};',module=>{const before=module.default;module.change();return [before.name,before.value,module.default.name,module.default.value];}],
    ['export default function(){return 3};',module=>[module.default.name,module.default()]],
    ['export default function(){}export const after=9;',module=>[module.default.name,module.after]],
    ['export default class {static observed=this.name};',module=>[module.default.name,module.default.observed]],
    ['export default async()=>9;',async module=>[module.default.name,await module.default()]],
    ['export default function*(){yield 9};',module=>[module.default.name,module.default().next().value]],
    ["export default (1,(await import('./child.js')).value);",module=>module.default],
    ['export default {path:new URL(import.meta.url).pathname};',module=>module.default.path],
    ["export const events=[];const value=()=>{events.push('default');return 1};export default value();",module=>[module.default,module.events.length]],
  ];
  for(const [source,observe] of cases){
    const f=fixture();
    try{
      fs.writeFileSync(f.child,'export const value={id:7};');fs.writeFileSync(f.entry,source);
      const compiled=await f.load(),native=await import(pathToFileURL(f.entry).href);
      assert.deepEqual(await observe(compiled),await observe(native),source);
      assert.equal(await f.load(),compiled,'unchanged default module must be evaluated once');
    }finally{f.close();}
  }
});

test('default-exported game objects and class methods are collected after old wrappers are released',()=>{
  const f=fixture();
  try{
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {createHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const entry='+JSON.stringify(f.entry)+',url='+JSON.stringify(pathToFileURL(f.entry).href)+';',
      'const resolver=createHotResolver({directories:['+JSON.stringify(f.root)+'],residentFiles:[],mode:()=>"test"});',
      'const loader=createCollectibleEntryLoader({entries:[entry],resolver}),weak=[];let retained;',
      'for(let n=0;n<300;n++){',
      'fs.writeFileSync(entry,"class Game{value(){return "+n+"}}export default new Game();");',
      'const location=resolver.resolve(url+"?v=default-"+n,{},value=>({url:value})).url;',
      'const module=await loader.load(location);assert.equal(module.default.value(),n);',
      'weak.push([module,module.default,module.default.constructor,module.default.value].map(value=>new WeakRef(value)));',
      'if(n===0)retained=module.default;await new Promise(resolve=>setImmediate(resolve));}',
      'for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));global.gc();}',
      'assert.equal(retained.value(),0);assert.ok(weak.slice(1,-1).every(row=>row.every(ref=>ref.deref()===undefined)),"old default objects or classes retained");',
      'assert.equal(loader.stats().compiledEntries,300);assert.equal(loader.stats().weakVersions,256);console.log("PASS_DEFAULT_GAME_GC");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_DEFAULT_GAME_GC/);
  }finally{f.close();}
});

test('real arcade default instances are collected when their changed entry wrappers are released',()=>{
  const f=fixture();
  try{
    const original=new URL('../../game-server/src/games/arcade-bcbm/index.js',import.meta.url);
    const source=fs.readFileSync(original,'utf8')
      .replace("'../../rel.js'",JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href))
      .replace("'../../core/TurntableGame.js'",JSON.stringify(new URL('../../core/TurntableGame.js',original).href))
      .replace("'./config.js'",JSON.stringify(new URL('./config.js',original).href));
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {installHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const entry='+JSON.stringify(f.entry)+',url='+JSON.stringify(pathToFileURL(f.entry).href)+',source='+JSON.stringify(source)+';',
      'const resolver=installHotResolver(),loader=createCollectibleEntryLoader({entries:[entry],resolver}),weak=[];let retained;',
      'for(let n=0;n<120;n++){',
      'fs.writeFileSync(entry,source+"\\nexport const revision="+n+";");',
      'const module=await loader.load(resolver.resolve(url+"?v=arcade-"+n,{},value=>({url:value})).url);',
      'assert.equal(module.revision,n);assert.equal(module.default.id,"arcade-bcbm");assert.equal(module.default.roomType,53);',
      'weak.push([module,module.default].map(value=>new WeakRef(value)));if(n===0)retained=module.default;',
      'await new Promise(resolve=>setImmediate(resolve));}',
      'for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));global.gc();}',
      'assert.equal(retained.id,"arcade-bcbm");assert.equal(retained.roomType,53);',
      'assert.ok(weak.slice(1,-1).every(row=>row.every(ref=>ref.deref()===undefined)),"old arcade instances retained");',
      'assert.equal(loader.stats().compiledEntries,120);assert.equal(loader.stats().pendingEntries,0);assert.equal(loader.stats().dependencyWaits,0);console.log("PASS_ARCADE_GC");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_ARCADE_GC/);
  }finally{f.close();}
});

test('a source edit between resolution and compilation never replaces the old handler with mislabeled code',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.entry,'export const revision=0;');
    const old=await f.load();
    fs.writeFileSync(f.entry,'export const revision=111;');
    const resolved=f.location();
    fs.writeFileSync(f.entry,'export const revision=2222;');
    await assert.rejects(f.loader.load(resolved),{code:'ERR_HOT_SOURCE_CHANGED'});
    assert.equal(old.revision,0);assert.equal(f.loader.stats().activeEntries,1);
    assert.equal(f.loader.stats().pendingEntries,0);
    assert.equal((await f.load()).revision,2222);
  }finally{f.close();}
});

test('transitive dependency edits invalidate an unresolved parent even when its own source is unchanged',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.child,'export const value=1;');
    fs.writeFileSync(f.entry,"import * as child from './child.js';export const value=()=>child.value;");
    const old=await f.load();
    fs.writeFileSync(f.child,'export const value=22;');
    const resolved=f.location();
    fs.writeFileSync(f.child,'export const value=333;');
    await assert.rejects(f.loader.load(resolved),{code:'ERR_HOT_SOURCE_CHANGED'});
    assert.equal(old.value(),1);assert.equal((await f.load()).value(),333);
  }finally{f.close();}
});

test('static and direct loads share one selected namespace despite query parameter ordering',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.child,'export const value={shared:true};');
    fs.writeFileSync(f.entry,"import * as child from './child.js';export {child};");
    const root=new URL(f.location());root.searchParams.set('link','2');
    const direct=new URL(f.location(f.child));direct.searchParams.set('link','2');
    const module=await f.loader.load(root.href),child=await f.loader.load(direct.href);
    assert.equal(module.child,child);
    assert.equal(f.loader.stats().compiledEntries,2);assert.equal(f.loader.stats().weakVersions,2);
    assert.equal(f.loader.stats().dependencyWaits,0);
  }finally{f.close();}
});

test('a collectible class and a direct native import reuse the same native configuration namespace',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.child,'export const settings={minimum:100};');
    fs.writeFileSync(f.entry,"import * as config from './child.js';export {config};");
    const loader=createCollectibleEntryLoader({entries:[f.entry],resolver:f.resolver});
    const entry=new URL(f.location());entry.searchParams.set('link','2');
    const child=new URL(f.location(f.child));child.searchParams.set('link','2');
    const module=await loader.load(entry.href),native=await import(child.href);
    assert.equal(module.config,native);
    assert.equal(module.config.settings,native.settings);
  }finally{f.close();}
});

test('collectible engines observe the same live environment and RPC namespace as resident code',()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.entry,"import {env} from "+JSON.stringify(new URL('../../shared/rpc/env.js',import.meta.url).href)+";export const read=()=>({dev:env.isDev,flag:env.config.testFlag});");
    const script=[
      "import assert from 'node:assert/strict';",
      'import {env,loadEnv} from '+JSON.stringify(new URL('../../shared/rpc/env.js',import.meta.url).href)+';',
      'import * as originalRPC from '+JSON.stringify(new URL('../../shared/rpc/index.js',import.meta.url).href)+';',
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {installHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'import {importHotModule} from '+JSON.stringify(new URL('../../shared/hot-import.js',import.meta.url).href)+';',
      'delete process.env.IS_DEV;delete process.env.GOGAME_ENV;delete process.env.NODE_ENV;',
      'loadEnv({env:"prod",testFlag:"current"});',
      'const resolver=installHotResolver(),loader=createCollectibleEntryLoader({entries:['+JSON.stringify(f.entry)+'],resolver});',
      'const entry=await loader.load(resolver.resolve('+JSON.stringify(pathToFileURL(f.entry).href+'?v=engine-env&link=2')+',{},value=>({url:value})).url);',
      'assert.deepEqual(entry.read(),{dev:false,flag:"current"});loadEnv({env:"dev",testFlag:"next"});assert.deepEqual(entry.read(),{dev:true,flag:"next"});',
      'assert.equal(await importHotModule('+JSON.stringify(new URL('../../shared/rpc/index.js',import.meta.url).href)+',"rpc-identity"),originalRPC);console.log("PASS_ENGINE_RESIDENT_IDENTITY");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_ENGINE_RESIDENT_IDENTITY/);
  }finally{f.close();}
});

test('equal-size edits are detected even when filesystem timestamps have not changed',async()=>{
  const f=fixture(),originalStat=fs.statSync;
  try{
    fs.writeFileSync(f.child,'export const value=1;');
    fs.writeFileSync(f.entry,"import * as child from './child.js';export const value=()=>child.value;");
    const stamp=originalStat(f.child);
    fs.statSync=(file,...args)=>{
      const stat=originalStat(file,...args);
      return String(file)===f.child?{...stat,mtimeMs:stamp.mtimeMs,ctimeMs:stamp.ctimeMs}:stat;
    };
    assert.equal((await f.load()).value(),1);
    fs.writeFileSync(f.child,'export const value=2;');
    assert.equal((await f.load()).value(),2);
  }finally{fs.statSync=originalStat;f.close();}
});

test('concurrent entry cycles reject and release their dependency waits instead of deadlocking',async()=>{
  const f=fixture();let timeout;
  try{
    fs.writeFileSync(f.entry,"import 'gate';import {b} from './child.js';export const a=1;");
    fs.writeFileSync(f.child,"import 'gate';import {a} from './entry.js';export const b=2;");
    let arrived=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    const loader=createCollectibleEntryLoader({entries:[f.entry,f.child],resolver:f.resolver,importModule:async specifier=>{
      assert.equal(specifier,'gate');if(++arrived===2)release();await gate;return {};
    }});
    const firstURL=new URL(f.location()),secondURL=new URL(f.location(f.child));
    firstURL.searchParams.set('link','2');secondURL.searchParams.set('link','2');
    const results=await Promise.race([
      Promise.allSettled([loader.load(firstURL.href),loader.load(secondURL.href)]),
      new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('concurrent entries deadlocked')),1000);}),
    ]);
    assert.ok(results.every(result=>result.status==='rejected'&&/Cyclic collectible/.test(result.reason.message)));
    assert.equal(loader.stats().pendingEntries,0);assert.equal(loader.stats().dependencyWaits,0);
  }finally{clearTimeout(timeout);f.close();}
});

test('concurrent acyclic entries share a dependency without false cycle errors or retained waits',async()=>{
  const f=fixture(),other=path.join(f.root,'other.js');
  try{
    fs.writeFileSync(f.entry,"import 'gate';import {value} from './child.js';export const first=value;");
    fs.writeFileSync(other,"import 'gate';import {value} from './child.js';export const second=value;");
    fs.writeFileSync(f.child,'export const value={shared:true};');
    let arrived=0,release;
    const gate=new Promise(resolve=>{release=resolve;});
    const loader=createCollectibleEntryLoader({entries:[f.entry,other,f.child],resolver:f.resolver,importModule:async specifier=>{
      assert.equal(specifier,'gate');if(++arrived===2)release();await gate;return {};
    }});
    const [first,second]=await Promise.all([loader.load(f.location()),loader.load(f.location(other))]);
    assert.equal(first.first,second.second);assert.equal(first.first.shared,true);
    assert.equal(loader.stats().compiledEntries,3);assert.equal(loader.stats().compileFailures,0);
    assert.equal(loader.stats().pendingEntries,0);assert.equal(loader.stats().dependencyWaits,0);
  }finally{f.close();}
});

test('creating a previously missing dependency changes the graph and recovers the failed entry',async()=>{
  const f=fixture();
  try{
    fs.writeFileSync(f.entry,"import {value} from './child.js';export const result=value;");
    const missing=f.location();
    await assert.rejects(f.loader.load(missing),{code:'ENOENT'});
    fs.writeFileSync(f.child,'export const value=77;');
    const ready=f.location();assert.notEqual(ready,missing);
    assert.equal((await f.loader.load(ready)).result,77);
    assert.equal(f.loader.stats().pendingEntries,0);assert.equal(f.loader.stats().dependencyWaits,0);
  }finally{f.close();}
});

test('collectible entry whitelist rejects unsupported exports and selected cycles without hanging',async()=>{
  const f=fixture();
  try{
    assert.equal(f.loader.handles('node:fs'),false);
    assert.equal(f.loader.handles(pathToFileURL(path.join(f.root,'other.js')).href),false);
    assert.equal(await f.loader.load(pathToFileURL(path.join(f.root,'other.js')).href),null);
    fs.writeFileSync(f.entry,"export * from './child.js';");
    await assert.rejects(f.load(),/do not support export-all/);
    fs.writeFileSync(f.entry,"import {child} from './child.js';export const entry=child;");
    fs.writeFileSync(f.child,"import {entry} from './entry.js';export const child=entry;");
    await assert.rejects(f.load(),/Cyclic collectible/);
    assert.equal(f.loader.stats().pendingEntries,0);
    assert.equal(f.loader.stats().activeEntries,0);
  }finally{f.close();}
});

test('released collectible entry namespaces are garbage collected while an old exported handler stays usable',()=>{
  const f=fixture();
  try{
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {createHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const entry='+JSON.stringify(f.entry)+',url='+JSON.stringify(pathToFileURL(f.entry).href)+';',
      'const resolver=createHotResolver({directories:['+JSON.stringify(f.root)+'],residentFiles:[],mode:()=>"test"});',
      'const loader=createCollectibleEntryLoader({entries:[entry],resolver});',
      'const weak=[],functions=[];let retained,releasedLocation;',
      'for(let n=0;n<300;n++){',
      'fs.writeFileSync(entry,"export const handle=()=>"+n+";"+"\\n".repeat(n));',
      'const location=resolver.resolve(url+"?v=revision-"+n,{},value=>({url:value})).url;',
      'if(n===7)releasedLocation=location;',
      'const module=await loader.load(location);assert.equal(module.handle(),n);weak.push(new WeakRef(module));functions.push(new WeakRef(module.handle));if(n===0)retained=module.handle;',
      'await new Promise(resolve=>setImmediate(resolve));}',
      'for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));global.gc();}',
      'assert.equal(retained(),0);assert.ok(weak.slice(1,-1).every(ref=>ref.deref()===undefined),"old namespaces retained");',
      'assert.ok(functions.slice(1,-1).every(ref=>ref.deref()===undefined),"old exported functions retained");',
      'assert.equal(weak.at(-1).deref().handle(),299);assert.equal(loader.stats().activeEntries,1);',
      'assert.equal(loader.stats().weakVersions,256);assert.equal(loader.stats().compiledEntries,300);',
      'await assert.rejects(loader.load(releasedLocation),{code:"ERR_HOT_SOURCE_CHANGED"});',
      'assert.equal(weak.at(-1).deref().handle(),299);assert.equal(loader.stats().pendingEntries,0);console.log("PASS_ENTRY_GC");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_ENTRY_GC/);
  }finally{f.close();}
});

test('real handler source copies use collectible loading with live heartbeats and bad-source rollback',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/collectible-handler-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--loader=collectible','--entry=handler','--revisions=26','--clients=4','--sample-every=13','--output='+output],
    {cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.loader,'collectible');assert.equal(report.entry,'handler');
    assert.equal(report.successfulChanges,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.requests,112);assert.equal(report.remainingSessions,0);assert.deepEqual(report.errors,[]);
    assert.ok(report.samples.every(row=>row.factories.activeEntries===3+collectibleGameEntryFiles.length+collectibleGameClassFiles.length+collectibleGameBaseFiles.length+collectibleGameEngineFiles.length+collectibleGameHelperFiles.length+collectibleHistoryFiles.length-1+collectibleRuleFiles.length+collectibleCoreHelperFiles.length-1+collectibleFinanceHelperFiles.length-1+collectibleFinanceControllerFiles.length-1+collectibleWalletFacadeFiles.length+collectibleRoomRuntimeFiles.length+collectiblePlayerServiceFiles.length-1+collectibleTournamentFiles.length-1+41/* reviewed config/protocol and control dependencies; lazy tools excluded */&&row.factories.pendingEntries===0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});

test('old codec dependency namespaces and functions are collected with their released parent entries',()=>{
  const f=fixture();
  try{
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';",
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {createHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const entry='+JSON.stringify(f.entry)+',child='+JSON.stringify(f.child)+';',
      'const rootURL='+JSON.stringify(pathToFileURL(f.entry).href)+',childURL='+JSON.stringify(pathToFileURL(f.child).href)+';',
      'const resolver=createHotResolver({directories:['+JSON.stringify(f.root)+'],residentFiles:[],mode:()=>"test"});',
      'const loader=createCollectibleEntryLoader({entries:[entry,child],resolver});',
      'const source=fs.readFileSync('+JSON.stringify(fileURLToPath(new URL('../../game-server/src/codec.js',import.meta.url)))+',"utf8");',
      'fs.writeFileSync(entry,"import * as codec from \'./child.js\';export const handle=()=>({revision:codec.revision,frame:codec.decodeFrame(codec.encodeFrame(1200))});");',
      'const resolve=(url,n)=>resolver.resolve(url+"?v=dependency-"+n,{},value=>({url:value})).url;',
      'const weak=[];let retained;',
      'for(let n=0;n<120;n++){',
      'fs.writeFileSync(child,source+"\\nexport const revision="+n+";"+"\\n".repeat(n));',
      'const parent=await loader.load(resolve(rootURL,n)),module=await loader.load(resolve(childURL,n));',
      'assert.equal(parent.handle().revision,n);assert.equal(parent.handle().frame.msgid,1200);',
      'weak.push([parent,module,module.decodeFrame,module.encodeFrame].map(value=>new WeakRef(value)));',
      'if(n===0)retained=parent.handle;await new Promise(resolve=>setImmediate(resolve));}',
      'for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));global.gc();}',
      'assert.equal(retained().revision,0);assert.equal(retained().frame.msgid,1200);',
      'assert.ok(weak.slice(1,-1).every(row=>row.every(ref=>ref.deref()===undefined)),"released dependency graph retained");',
      'assert.equal(loader.stats().activeEntries,2);assert.equal(loader.stats().compiledEntries,240);console.log("PASS_CODEC_GRAPH_GC");',
    ].join('\n');
    const result=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',script],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_CODEC_GRAPH_GC/);
  }finally{f.close();}
});

test('real codec dependency changes retain protocol heartbeats and old lazy callers',()=>{
  const root=fileURLToPath(new URL('../../',import.meta.url));
  const output='cache/collectible-codec-test-'+process.pid+'-'+Date.now()+'.json';
  try{
    const result=spawnSync(process.execPath,['--expose-gc','test/performance/hot-source-change-load.mjs',
      '--loader=collectible','--entry=codec','--revisions=26','--clients=4','--sample-every=13','--output='+output],
    {cwd:root,encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);
    const report=JSON.parse(fs.readFileSync(path.join(root,output),'utf8'));
    assert.equal(report.loader,'collectible');assert.equal(report.entry,'codec');
    assert.equal(report.successfulChanges,26);assert.equal(report.failedCompileAttempts,1);
    assert.equal(report.requests,112);assert.equal(report.remainingSessions,0);assert.deepEqual(report.errors,[]);
    assert.ok(report.samples.every(row=>row.factories.activeEntries===2+collectibleGameEntryFiles.length+collectibleGameClassFiles.length+collectibleGameBaseFiles.length+collectibleGameEngineFiles.length+collectibleGameHelperFiles.length+collectibleHistoryFiles.length-1+collectibleRuleFiles.length+collectibleCoreHelperFiles.length-1+collectibleFinanceHelperFiles.length-1+collectibleFinanceControllerFiles.length-1+collectibleWalletFacadeFiles.length+collectibleRoomRuntimeFiles.length+collectiblePlayerServiceFiles.length-1+collectibleTournamentFiles.length-1+41/* reviewed config/protocol and control dependencies; lazy tools excluded */&&row.factories.pendingEntries===0));
  }finally{fs.rmSync(path.join(root,output),{force:true});}
});
