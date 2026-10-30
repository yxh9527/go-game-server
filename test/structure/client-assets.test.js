import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliOptions, decodeUuid, importFiles, nativeExtension, syncAssets } from '../../scripts/sync-client-assets.js';

async function fixture(t, { responseOverrides = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gogame-assets-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src/settings.12345.js'), 'window._CCSettings={bundleVers:{holdemGame_zh_cn_Turntable:"616e0"}};');
  const uuid = '71910f60-d485-49f4-824f-dc72658407e0';
  const config = { name:'holdemGame_zh_cn_Turntable', importBase:'import', nativeBase:'native',
    uuids:['71kQ9g1IVJ9IJP3HJlhAfg'], deps:[], packs:{}, versions:{import:[0,'0039e'],native:[0,'93464']} };
  const prefix='assets/holdemGame_zh_cn_Turntable/';
  const files = {
    [prefix+'config.616e0.json']: JSON.stringify(config),
    [prefix+'index.616e0.js']: 'window.originalLanguageBundle=true;',
    [prefix+'import/71/'+uuid+'.0039e.json']: JSON.stringify([1,0,0,[['cc.AudioClip',['_name','_native'],0]],0,[[0,'start_bet','.mp3']]]),
    [prefix+'native/71/'+uuid+'.93464.mp3']: 'ID3_original_audio_fixture',
    ...responseOverrides,
  };
  const requested=[];
  const fetcher=async url=>{
    const key=url.pathname.replace('/2.0.1279/','');requested.push(key);
    return new Response(files[key] ?? 'missing', {status:files[key]===undefined?404:200});
  };
  return {root,fetcher,requested,prefix,files,config};
}

test('asset UUID, version paths and native metadata match original Cocos encoding', () => {
  assert.equal(decodeUuid('71kQ9g1IVJ9IJP3HJlhAfg'),'71910f60-d485-49f4-824f-dc72658407e0');
  assert.throws(()=>decodeUuid('../../outside'));
  assert.throws(()=>cliOptions(['--source','https://example/2.0.1392/']));
  assert.throws(()=>cliOptions(['--version','../../outside']));
  assert.deepEqual([...importFiles({uuids:['71kQ9g1IVJ9IJP3HJlhAfg'],versions:{import:[0,'0039e']}}).values()],
    ['import/71/71910f60-d485-49f4-824f-dc72658407e0.0039e.json']);
  assert.equal(nativeExtension({packs:{abc123:[0]},uuids:['71kQ9g1IVJ9IJP3HJlhAfg']},0,
    new Map([['abc123',{type:'cc.Texture2D',data:'0,9729,9729,33071'}]])),'.png');
  assert.equal(nativeExtension({packs:{abc123:[0]}},0,new Map([['abc123',
    [1,0,0,['cc.SpriteFrame','cc.Texture2D'],0,[[['0,9729,9729,33071',-1],[1],0,[],[],[]]]]]])),'.png');
  assert.equal(nativeExtension({},0,new Map([[0,[1,0,0,[['cc.TTFFont',['_name','_native'],1]],0,
    [[0,'ASAP-BOLD','ASAP-BOLD.ttf']]]]])),'/ASAP-BOLD.ttf');
});

test('downloads original language config, code, imports and native audio without overwriting on repeat', async t => {
  const f=await fixture(t),options={...f,source:'https://example/2.0.1279/',bundles:['holdemGame_zh_cn_Turntable']};
  const first=await syncAssets(options);assert.deepEqual(first.errors,[]);assert.equal(first.downloaded.length,4);
  assert.equal(first.outputDirectory,path.resolve(f.root));
  const second=await syncAssets(options);assert.deepEqual(second.errors,[]);assert.equal(second.downloaded.length,0);
  assert.equal(second.existing,4);assert.equal(f.requested.length,4);
  for(const [relative,content] of Object.entries(f.files))assert.equal(await fs.readFile(path.join(f.root,relative),'utf8'),content);
});

test('offline audit reports missing resources without making network calls', async t => {
  const f=await fixture(t);const result=await syncAssets({...f,all:true,audit:true});
  assert.deepEqual(result.missing,[f.prefix+'config.616e0.json']);assert.equal(f.requested.length,0);
});

test('rejects HTML, mismatched manifests and credential-bearing URLs without saving invalid originals', async t => {
  for(const content of ['<!doctype html><html>login</html>',JSON.stringify({name:'wrongVersionBundle'})]){
    const f=await fixture(t,{responseOverrides:{'assets/holdemGame_zh_cn_Turntable/config.616e0.json':content}});
    const result=await syncAssets({...f,source:'https://example/2.0.1279/',all:true});
    assert.equal(result.errors.length,1);assert.equal(result.downloaded.length,0);
    await assert.rejects(fs.access(path.join(f.root,f.prefix+'config.616e0.json')));
  }
  const f=await fixture(t);
  await assert.rejects(syncAssets({...f,source:'https://example/2.0.1279/?userToken=secret',all:true}));
  assert.equal(f.requested.length,0);
});

test('a broken existing original is reported and remains untouched', async t => {
  const f=await fixture(t);await fs.mkdir(path.join(f.root,f.prefix),{recursive:true});
  const file=path.join(f.root,f.prefix+'config.616e0.json');await fs.writeFile(file,'broken existing original');
  const result=await syncAssets({...f,source:'https://example/2.0.1279/',all:true});
  assert.equal(result.errors.length,1);assert.equal(f.requested.length,0);
  assert.equal(await fs.readFile(file,'utf8'),'broken existing original');
});
