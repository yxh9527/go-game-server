import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {rpcAccessFixture,rpcAccessServices} from '../fixtures/hot-rpc-access.mjs';
import {createCollectibleEntryLoader,collectibleRpcAccessFiles,collectibleModuleFiles} from '../../shared/hot-entry-factory.js';
import {installHotResolver} from '../../shared/hot-loader.js';

test('RPC refresh preserves owners and an in-flight authoritative request without repeating it',async()=>{
  const f=rpcAccessFixture();let release;
  try{
    const source=f.sources.find(item=>item.file.endsWith('commonRpcProd.js'));
    source.source=source.source.replace('export class CommonRpcProd {','export class CommonRpcProd { hotRevision(){return hotTestRevision;}');
    const rpc=await rpcAccessServices(f,0),original={...rpc},owner={pending:new Map()},calls=[];
    assert.equal(rpc.commonService.hotRevision(),0);
    rpc.commonService.financeOwner=owner;
    rpc.commonService.lottery=async()=>({bet:request=>{calls.push(request);return new Promise(resolve=>{release=resolve;});}});
    const request={agent:7,userId:42,requestId:'original'};
    const pending=rpc.commonService.finance('bet',request);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
    f.write(1);const {refreshDataAccess}=await f.load('rpcAdapter.js',1);await refreshDataAccess({env:'prod',hotVersion:'refresh-1',rpc});
    for(const key of Object.keys(original))assert.equal(rpc[key],original[key]);
    assert.equal(rpc.commonService.hotRevision(),1,'refresh retained old business methods');
    assert.equal(rpc.commonService.financeOwner,owner);assert.equal(calls.length,1);
    release({ok:true,requestId:'original'});assert.deepEqual(await pending,{ok:true,requestId:'original'});
    await assert.rejects(rpc.commonService.finance('unsupported',request),/Unsupported/);assert.equal(calls.length,1);
  }finally{release?.({ok:true});f.close();}
});

test('an original data-center callback transaction finishes across business replacement',async()=>{
  const f=rpcAccessFixture();let release;
  try{
    f.write(0);const {createDataCenterStore}=await f.load('dataCenterStore.js',0),document={row:{id:9,state:1},state:{registrations:{}}};let transactions=0;
    const getClient=async()=>({withMatch:async(id,work)=>{transactions++;assert.equal(id,9);return work(document);}});
    const old=createDataCenterStore(getClient),pending=old.withMatch(9,async({row})=>{await new Promise(resolve=>{release=resolve;});row.state=4;return 'committed';});
    await new Promise(resolve=>setImmediate(resolve));f.write(1);const next=(await f.load('dataCenterStore.js',1)).createDataCenterStore(getClient);
    assert.notEqual(old.withMatch,next.withMatch);assert.equal(transactions,1);release();assert.equal(await pending,'committed');assert.equal(document.row.state,4);assert.equal(transactions,1);
  }finally{release?.();f.close();}
});

test('RPC transport and injected Redis dependency remain resident outside business factories',()=>{
  assert.equal(collectibleRpcAccessFiles.length,6);assert.equal(collectibleModuleFiles.length,242);
  const resolver=installHotResolver(),loader=createCollectibleEntryLoader();
  for(const file of ['utils/dataCenterGrpc.js','utils/gogameStorageGrpc.js','utils/lotteryGrpc.js','implementations/prod/prodDeps.js']){
    const url=new URL('../../shared/rpc/'+file,import.meta.url);assert.equal(loader.handles(url.href),false);url.searchParams.set('v','changed');
    assert.equal(resolver.resolve(url.href,{},value=>({url:value})).url,new URL('../../shared/rpc/'+file,import.meta.url).href);
  }
});

test('released RPC facades and repository closures can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-rpc-access.mjs','--rpc-access-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_RPC_ACCESS_GC/);
});
