import test from 'node:test';
import assert from 'node:assert/strict';
import {hallUserCenterFixture} from '../fixtures/hot-hall-user-center.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

function quiet(runtime){runtime.userCenterProjection.watcher.close();}

test('a resident collectible hall refreshes the actual edited projection rather than its pinned original import',async()=>{
  const f=hallUserCenterFixture();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,1);
    const watcher=runtime.userCenterProjection.watcher;f.write(2);watcher.emit('change','change','user-center.js');
    const changed=await first.userCenterResponse(runtime,27,f.params);assert.equal(changed.msgCode,200);assert.equal(changed.data.revision,2,'edited projection stayed pinned to version one');assert.equal(runtime.userCenterProjection.watcher,watcher);
  }finally{f.close();}
});

test('a late request from an original hall cannot restore its projection over an already used replacement',async()=>{
  const f=hallUserCenterFixture();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,1);
    f.write(2);const next=await f.load();assert.equal((await next.userCenterResponse(runtime,27,f.params)).data.revision,2);
    assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,2,'original caller reset current shared projection');
  }finally{f.close();}
});

test('a delayed old projection refresh cannot replace a newer adopted handler projection',async()=>{
  const f=hallUserCenterFixture(),gate=deferred(),started=deferred();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();await first.userCenterResponse(runtime,27,f.params);quiet(runtime);
    f.write(2);runtime.userCenterProjection.watcher.emit('change','change','user-center.js');f.onReload(async()=>{started.resolve();await gate.promise;});
    const pending=first.userCenterResponse(runtime,27,f.params);await started.promise;
    f.write(3);const next=await f.load(),fresh=next.userCenterResponse(runtime,27,f.params);await new Promise(resolve=>setImmediate(resolve));gate.resolve();
    const [oldReply,newReply]=await Promise.all([pending,fresh]);assert.equal(oldReply.data.revision,3);assert.equal(newReply.data.revision,3);assert.equal(runtime.userCenterProjection.project().revision,3);
  }finally{gate.resolve();f.close();}
});

test('an edit arriving during an existing reload is loaded before returning the current projection',async()=>{
  const f=hallUserCenterFixture(),gate=deferred(),started=deferred();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();await first.userCenterResponse(runtime,27,f.params);quiet(runtime);
    f.write(2);runtime.userCenterProjection.watcher.emit('change','change','user-center.js');let attempts=0;f.onReload(async()=>{if(++attempts===1){started.resolve();await gate.promise;}});
    const pending=first.userCenterResponse(runtime,27,f.params);await started.promise;f.write(3);runtime.userCenterProjection.watcher.emit('change','change','user-center.js');gate.resolve();
    const reply=await pending;assert.equal(reply.msgCode,200);assert.equal(reply.data.revision,3);assert.equal(attempts,2);assert.equal(runtime.userCenterProjection.loading,null);assert.equal(runtime.userCenterProjection.dirty,false);
  }finally{gate.resolve();f.close();}
});

test('a failed edit retains the working projection and a later fixed edit can load without restarting',async()=>{
  const f=hallUserCenterFixture();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();await first.userCenterResponse(runtime,27,f.params);quiet(runtime);
    f.write(';');runtime.userCenterProjection.watcher.emit('change','change','user-center.js');const failed=await first.userCenterResponse(runtime,27,f.params);assert.equal(failed.msgCode,503);assert.equal(runtime.userCenterProjection.project().revision,1);assert.equal(runtime.userCenterProjection.loading,null);
    f.write(2);runtime.userCenterProjection.watcher.emit('change','rename','user-center.js');assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,2);
  }finally{f.close();}
});

test('watcher upgrade closes a legacy listener once, shares its replacement and reopens after an error',async()=>{
  const f=hallUserCenterFixture();try{
    f.write(1);const first=await f.load(),runtime=f.runtime(),errors=[];let closed=0;
    runtime.log.error=(...args)=>errors.push(args);runtime.userCenterProjection={version:'legacy',project:()=>({revision:0}),dirty:false,loading:null,watcher:{close(){closed++;}}};
    assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,1);assert.equal(closed,1);const watcher=runtime.userCenterProjection.watcher;assert.equal(runtime.userCenterProjection.watchFormat,2);
    f.write(2);const next=await f.load();await next.userCenterResponse(runtime,27,f.params);assert.equal(runtime.userCenterProjection.watcher,watcher);assert.equal(closed,1);
    watcher.emit('error',Error('watch failed'));assert.equal(runtime.userCenterProjection.watcher,null);assert.equal(errors.length,1);
    const recovered=await next.userCenterResponse(runtime,27,f.params);assert.equal(recovered.msgCode,200);assert.equal(recovered.data.revision,2);assert.ok(runtime.userCenterProjection.watcher);assert.notEqual(runtime.userCenterProjection.watcher,watcher);
  }finally{f.close();}
});

test('unrelated watch changes do not reload and missing filenames conservatively refresh the projection',async()=>{
  const f=hallUserCenterFixture();try{
    f.write(1);const first=await f.load(),runtime=f.runtime();await first.userCenterResponse(runtime,27,f.params);quiet(runtime);let reloads=0;f.onReload(()=>{reloads++;});
    runtime.userCenterProjection.watcher.emit('change','change','other.js');await first.userCenterResponse(runtime,27,f.params);assert.equal(reloads,0);
    f.write(2);runtime.userCenterProjection.watcher.emit('change','rename',null);assert.equal((await first.userCenterResponse(runtime,27,f.params)).data.revision,2);assert.equal(reloads,1);
  }finally{f.close();}
});

test('the single resident file watcher does not retain released hall business generations',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hall-projection-gc.mjs'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8',timeout:30000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_RESIDENT_HALL_PROJECTION_GC/);
});
