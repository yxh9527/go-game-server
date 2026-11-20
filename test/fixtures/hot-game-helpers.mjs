import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parse} from 'acorn';
import {createCollectibleEntryLoader,collectibleGameHelperFiles} from '../../shared/hot-entry-factory.js';
import {installHotResolver} from '../../shared/hot-loader.js';

assert.equal(typeof global.gc,'function','run with --expose-gc');
const cacheRoot=fileURLToPath(new URL('../../cache/',import.meta.url));
const temporary=fs.mkdtempSync(path.join(cacheRoot,'hot-game-helpers-'));
const sources=[...collectibleGameHelperFiles,fileURLToPath(new URL('../../game-server/src/games/holdem/engine.js',import.meta.url))]
  .map((file,index)=>({file,copy:path.join(temporary,index+'.js')}));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
try{
  for(const item of sources){
    const original=pathToFileURL(item.file),source=fs.readFileSync(item.file,'utf8'),edits=[];
    function visit(node){
      if(node.type==='Literal'&&typeof node.value==='string'&&/^\.{1,2}\/.*\.js$/.test(node.value)){
        const target=new URL(node.value,original),copy=sources.find(candidate=>candidate.file===fileURLToPath(target));
        edits.push({start:node.start,end:node.end,text:JSON.stringify(copy?'./'+sources.indexOf(copy)+'.js':target.href)});
      }
      for(const value of Object.values(node)){
        if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
        else if(value?.type)visit(value);
      }
    }
    visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));let relocated=source;
    for(const edit of edits.sort((a,b)=>b.start-a.start))relocated=relocated.slice(0,edit.start)+edit.text+relocated.slice(edit.end);
    item.source=relocated;
    if(item.file.endsWith(path.join('holdem','engine.js')))item.source+='\nexport const hotTestImportedName=id=>cardName(id);';
    if(item.file.endsWith(path.join('hundred-zjh','hand.js')))item.source+='\nexport const hotTestRankedCache=()=>rankedHands;';
    if(item.file.endsWith(path.join('sss','hand.js')))item.source+='\nexport const hotTestTemplates=[FIVE,HEAD];';
    if(item.file.endsWith('robot.js'))item.source+='\nexport const hotTestCaches=[typeof estimates==="undefined"?null:estimates,typeof ranks==="undefined"?null:ranks,typeof ratings==="undefined"?null:ratings];';
  }
  const resolver=installHotResolver(),loader=createCollectibleEntryLoader({entries:sources.map(item=>item.copy),resolver}),first=new Map(),weak=[];
  const key={},retainedCaches=[];let owned=0,rankedCaches=0;
  for(let revision=0;revision<24;revision++){
    for(const item of sources){
      const wrap=item.file.endsWith(path.join('holdem','cards.js'))?'\nconst hotTestName=cardName;cardName=id=>hotTestName(id)+"#'+revision+'";':'';
      fs.writeFileSync(item.copy,item.source+wrap+'\nexport const hotTestRevision='+revision+';');
    }
    for(const item of sources){
      const url=pathToFileURL(item.copy);url.searchParams.set('v','helpers-'+revision);url.searchParams.set('link','2');
      const module=await loader.load(resolver.resolve(url.href,{},value=>({url:value})).url);assert.equal(module.hotTestRevision,revision);
      if(revision===0)first.set(item.copy,module);
      if(module.hotTestImportedName){assert.equal(module.hotTestImportedName(0),'DIAMOND_A#'+revision);assert.equal(first.get(item.copy).hotTestImportedName(0),'DIAMOND_A#0');}
      if(module.hotTestRankedCache&&[0,1,23].includes(revision)){
        assert.ok(module.conditionalOutcomes([0,1,2],[13,14,15]).total>0);
        const rows=module.hotTestRankedCache();assert.equal(rows.length,22100);rankedCaches++;
        if(revision===1)weak.push({revision,refs:[new WeakRef(rows),...rows.slice(0,8).map(row=>new WeakRef(row))]});
      }
      for(const cache of module.hotTestCaches||[])if(cache){cache.set(key,{revision});if(revision===0)retainedCaches.push(cache);}
      const refs=[new WeakRef(module)],original=first.get(item.copy);
      for(const [name,value]of Object.entries(module))if(value!==original[name]&&value&&(typeof value==='object'||typeof value==='function')){
        refs.push(new WeakRef(value));owned++;
        if(typeof value==='object')for(const nested of Object.values(value))if(nested&&(typeof nested==='object'||typeof nested==='function'))refs.push(new WeakRef(nested));
      }
      weak.push({revision,refs});await tick();
    }
  }
  for(let i=0;i<10;i++){await tick();global.gc();}
  assert.ok(owned>300,'owned helpers, templates and strategy caches were not exercised');
  assert.equal(rankedCaches,3);assert.ok(retainedCaches.length>=4);
  for(const cache of retainedCaches)assert.equal(cache.get(key).revision,0,'retained old strategy changed cache');
  for(const module of first.values())assert.equal(module.hotTestRevision,0);
  assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released helper/strategy/engine graph retained');
  const stats=loader.stats();assert.equal(stats.activeEntries,27);assert.equal(stats.compiledEntries,648);assert.equal(stats.weakVersions,256);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
  console.log('PASS_REAL_HELPERS_GC',JSON.stringify({helpers:collectibleGameHelperFiles.length,versions:24,owned,rankedCaches,stats}));
}finally{
  assert.equal(path.dirname(temporary),path.resolve(cacheRoot));
  fs.rmSync(temporary,{recursive:true,force:true});
}
