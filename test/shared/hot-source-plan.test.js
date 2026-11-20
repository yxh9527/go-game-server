import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Parser} from 'acorn';
import {applySourceEdits,pinHotSource} from '../../shared/hot-source-pins.js';
import {createHotResolver} from '../../shared/hot-loader.js';
import {createCollectibleEntryLoader} from '../../shared/hot-entry-factory.js';

test('source edit assembly preserves boundary insertions and rejects overlapping or invalid ranges',()=>{
  assert.equal(applySourceEdits('abcdef',[
    {start:1,end:3,text:'X'},{start:1,end:1,text:'A'},
    {start:3,end:3,text:'B'},{start:5,end:6,text:'Z'},
  ]),'aAXBdeZ');
  assert.equal(applySourceEdits('x',[{start:0,end:0,text:'A'},{start:0,end:0,text:'B'}]),'BAx');
  assert.equal(applySourceEdits('unchanged',[]),'unchanged');
  for(const edits of [
    [{start:0,end:3,text:'A'},{start:2,end:4,text:'B'}],
    [{start:-1,end:2,text:'A'}],[{start:0,end:7,text:'A'}],
    [{start:3,end:2,text:'A'}],[{start:0.5,end:2,text:'A'}],
  ])assert.throws(()=>applySourceEdits('abcdef',edits),/Invalid or overlapping/);
});

test('factory source parsing is shared with dependency pin planning',async()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-single-parse-',import.meta.url));
  const original=Parser.parse;let parses=0;
  try{
    const entry=path.join(root,'entry.js');
    fs.writeFileSync(path.join(root,'rel.js'),"export const rel=()=>{throw Error('unpinned dependency')};");
    fs.writeFileSync(path.join(root,'child.js'),'export const value=17;');
    fs.writeFileSync(entry,"import {rel} from './rel.js';export const result=(await rel(import.meta.url,'./child.js',1)).value;");
    const resolver=createHotResolver({directories:[root],residentFiles:[],mode:()=> 'test'});
    const loader=createCollectibleEntryLoader({entries:[entry],resolver});
    const location=resolver.resolve(pathToFileURL(entry).href+'?v=one',{},value=>({url:value})).url;
    Parser.parse=function(...args){parses++;return Reflect.apply(original,this,args);};
    const module=await loader.load(location);
    assert.equal(module.result,17);assert.equal(parses,1,'factory parsed generated JavaScript again');
  }finally{Parser.parse=original;fs.rmSync(root,{recursive:true,force:true});}
});

test('single-parse nested pins preserve parenthesized arguments, imports, meta and old lazy results',async()=>{
  const root=fs.mkdtempSync(new URL('../../cache/hot-pin-plan-',import.meta.url));
  try{
    const entry=path.join(root,'entry.js'),child=path.join(root,'a.js');
    fs.writeFileSync(path.join(root,'rel.js'),"export const rel=()=>{throw Error('unpinned dependency')};");
    fs.writeFileSync(child,'export const value=17;');fs.writeFileSync(path.join(root,'b.js'),'export const value=29;');
    const source=[
      '#!/usr/bin/env node',
      "import {rel} from './rel.js';",
      'export const events=[];',
      "export const result=(await rel((import.meta.url),/*between*/'./a.js',((events.push('version'),await rel(import.meta.url,'./b.js',(events.push('inner'),1)))),(events.push('extra'),(()=>import.meta.url)()))).value;",
      "const paths=['./a.js'];export const later=()=>rel(import.meta.url,paths[0],1).then(value=>value.value);",
    ].join('\n');
    fs.writeFileSync(entry,source);
    const resolver=createHotResolver({directories:[root],residentFiles:[],mode:()=> 'test'});
    const location=token=>resolver.resolve(pathToFileURL(entry).href+'?v='+token,{},value=>({url:value})).url;
    const firstLocation=location('first'),loader=createCollectibleEntryLoader({entries:[entry],resolver});
    const first=await loader.load(firstLocation);
    const pinned=pinHotSource(source,firstLocation,resolver),nativeFile=path.join(root,'native.js');
    fs.writeFileSync(nativeFile,pinned.source);
    const native=await import(pathToFileURL(nativeFile).href);
    assert.equal(first.result,17);assert.equal(native.result,17);
    assert.deepEqual(first.events,['version','inner','extra']);assert.deepEqual(first.events,native.events);
    assert.equal(await first.later(),17);assert.equal(await native.later(),17);
    fs.writeFileSync(child,'export const value=111;');
    const next=await loader.load(location('changed'));
    assert.equal(next.result,111);assert.equal(await next.later(),111);assert.equal(await first.later(),17);
    assert.deepEqual(next.events,['version','inner','extra']);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
