import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parse} from 'acorn';
import {createCollectibleEntryLoader,collectibleHistoryFiles} from '../../shared/hot-entry-factory.js';
import {installHotResolver} from '../../shared/hot-loader.js';

export function historyFixture(files=collectibleHistoryFiles,{createLoader=createCollectibleEntryLoader}={}){
  const cacheRoot=fileURLToPath(new URL('../../cache/',import.meta.url)),temporary=fs.mkdtempSync(path.join(cacheRoot,'hot-history-'));
  const sources=files.map((file,index)=>({file,copy:path.join(temporary,index+'.js')}));
  for(const item of sources){
    const original=pathToFileURL(item.file);let source=fs.readFileSync(item.file,'utf8');const edits=[];
    function visit(node){
      if(node.type==='Literal'&&typeof node.value==='string'&&/^\.{1,2}\/.*\.js$/.test(node.value)){
        const target=new URL(node.value,original),selected=sources.find(candidate=>candidate.file===fileURLToPath(target));
        edits.push({start:node.start,end:node.end,text:JSON.stringify(selected?'./'+sources.indexOf(selected)+'.js':target.href)});
      }
      for(const value of Object.values(node)){
        if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}
        else if(value?.type)visit(value);
      }
    }
    visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));
    for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
    item.source=source;
  }
  const resolver=installHotResolver(),loader=createLoader({entries:sources.map(item=>item.copy),resolver});
  return {sources,loader,
    write(revision){for(const item of sources)fs.writeFileSync(item.copy,item.source+'\nexport const hotTestRevision='+revision+';');},
    async load(index,revision){
      const item=typeof index==='number'?sources[index]:sources.find(item=>item.file.replaceAll('\\','/').endsWith('/'+index));assert.ok(item,'fixture module '+index);
      const url=pathToFileURL(item.copy);url.searchParams.set('v','fixture-'+path.basename(temporary)+'-'+revision);url.searchParams.set('link','2');
      return loader.load(resolver.resolve(url.href,{},value=>({url:value})).url);
    },
    close(){assert.equal(path.dirname(temporary),path.resolve(cacheRoot));fs.rmSync(temporary,{recursive:true,force:true});},
  };
}

if(process.argv.includes('--history-gc')){
  assert.equal(typeof global.gc,'function');
  const fixture=historyFixture(),first=new Map(),weak=[];let owned=0;
  try{
    for(let revision=0;revision<24;revision++){
      fixture.write(revision);
      for(let index=0;index<fixture.sources.length;index++){
        const module=await fixture.load(index,revision);assert.equal(module.hotTestRevision,revision);
        if(revision===0)first.set(index,module);
        const refs=[new WeakRef(module)];
        for(const [key,value]of Object.entries(module))if(value!==first.get(index)[key]&&value&&(typeof value==='object'||typeof value==='function')){refs.push(new WeakRef(value));owned++;}
        weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));
      }
    }
    for(let i=0;i<10;i++){await new Promise(resolve=>setImmediate(resolve));global.gc();}
    assert.ok(owned>100);assert.ok(weak.filter(item=>item.revision>0&&item.revision<23).every(item=>item.refs.every(ref=>ref.deref()===undefined)),'released history graph retained');
    for(const module of first.values())assert.equal(module.hotTestRevision,0);
    const stats=fixture.loader.stats();assert.equal(stats.activeEntries,11);assert.equal(stats.compiledEntries,264);assert.equal(stats.weakVersions,256);assert.equal(stats.pendingEntries,0);assert.equal(stats.dependencyWaits,0);
    const empty=[...first.values()].find(module=>module.emptyHistoryPayload).emptyHistoryPayload({roomId:7,smallBlind:5,bigBlind:10});assert.equal(empty.gameRoomId,7);
    console.log('PASS_REAL_HISTORY_GC',JSON.stringify({modules:11,versions:24,owned,stats}));
  }finally{fixture.close();}
}
