import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {collectibleGameEngineFiles} from '../../shared/hot-entry-factory.js';

test('released real engine namespaces, owned functions and adapter engines can be collected',()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-engine-gc-',import.meta.url));
  try{
    const sources=collectibleGameEngineFiles.map((file,index)=>({file,copy:path.join(root,index+'.js')}));
    const script=[
      "import fs from 'node:fs';import assert from 'node:assert/strict';import {pathToFileURL,fileURLToPath} from 'node:url';import {parse} from 'acorn';",
      'import {createCollectibleEntryLoader} from '+JSON.stringify(new URL('../../shared/hot-entry-factory.js',import.meta.url).href)+';',
      'import {installHotResolver} from '+JSON.stringify(new URL('../../shared/hot-loader.js',import.meta.url).href)+';',
      'const sources='+JSON.stringify(sources)+';',
      'for(const item of sources){const original=pathToFileURL(item.file);let source=fs.readFileSync(item.file,"utf8");const edits=[];',
      'function visit(node){if(node.type==="Literal"&&typeof node.value==="string"&&/^\\.{1,2}\\/.*\\.js$/.test(node.value)){const target=new URL(node.value,original),copy=sources.find(source=>source.file===fileURLToPath(target));edits.push({start:node.start,end:node.end,text:JSON.stringify(copy?"./"+sources.indexOf(copy)+".js":target.href)});}for(const value of Object.values(node)){if(Array.isArray(value)){for(const child of value)if(child?.type)visit(child);}else if(value?.type)visit(value);}}',
      'visit(parse(source,{ecmaVersion:"latest",sourceType:"module"}));for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);item.source=source;}',
      'const resolver=installHotResolver(),loader=createCollectibleEntryLoader({entries:sources.map(item=>item.copy),resolver}),weak=[],first=new Map();let owned=0;',
      'for(let revision=0;revision<24;revision++){for(const item of sources)fs.writeFileSync(item.copy,item.source+"\\nexport const hotTestRevision="+revision+";");for(const item of sources){',
      'const url=pathToFileURL(item.copy);url.searchParams.set("v","engine-"+revision+"-"+sources.indexOf(item));url.searchParams.set("link","2");',
      'const module=await loader.load(resolver.resolve(url.href,{},value=>({url:value})).url);assert.equal(module.hotTestRevision,revision);',
      'if(revision===0)first.set(item.copy,module);const original=first.get(item.copy);',
      'const refs=[new WeakRef(module)];for(const [key,value]of Object.entries(module)){if(value!==original[key]&&value&&(typeof value==="object"||typeof value==="function")){refs.push(new WeakRef(value));owned++;if(typeof value==="object")for(const [name,nested]of Object.entries(value))if(typeof nested==="function"&&nested!==original[key]?.[name]){refs.push(new WeakRef(nested));owned++;}}}',
      'weak.push({revision,refs});await new Promise(resolve=>setImmediate(resolve));}}',
      'for(let n=0;n<8;n++){await new Promise(resolve=>setImmediate(resolve));global.gc();}',
      'for(const module of first.values())assert.equal(module.hotTestRevision,0);assert.ok(owned>100,"owned engine functions were not exercised");',
      'assert.ok(weak.filter(value=>value.revision>0&&value.revision<23).every(value=>value.refs.every(ref=>ref.deref()===undefined)),"released engine graph retained");',
      'assert.equal(loader.stats().activeEntries,17);assert.equal(loader.stats().compiledEntries,408);assert.equal(loader.stats().weakVersions,256);',
      'assert.equal(loader.stats().pendingEntries,0);assert.equal(loader.stats().dependencyWaits,0);console.log("PASS_REAL_ENGINES_GC");',
    ].join('\n');
    const entry=path.join(root,'verify.mjs');fs.writeFileSync(entry,script);
    const result=spawnSync(process.execPath,['--expose-gc',entry],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_REAL_ENGINES_GC/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
