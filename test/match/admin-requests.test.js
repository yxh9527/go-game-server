import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminRequests} from '../../match/src/admin-requests.js';

function fixture(){
  let identity={token:'platform',agent:'11'},changes=0;
  const calls=[];
  const client=createAdminRequests({identity:()=>identity,onIdentityChange:()=>changes++,send:(url,options)=>new Promise((resolve,reject)=>calls.push({url,options,resolve,reject}))});
  return {client,calls,change(value){identity={...identity,...value};return client.sync();},changes:()=>changes};
}
const reply=value=>({ok:true,json:async()=>({code:0,data:value})});

test('switching agent cancels stale reads and never accepts their late result',async()=>{
  const f=fixture();
  const old=f.client.request('/matches').catch(error=>error);
  const oldScope=f.client.sync();f.change({agent:'22'});
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.changes(),1);
  assert.throws(()=>f.client.assertScope(oldScope),{staleAdminRequest:true});
  const fresh=f.client.request('/matches');f.calls[1].resolve(reply([{agent:22}]));
  assert.deepEqual(await fresh,[{agent:22}]);f.calls[0].resolve(reply([{agent:11}]));
  assert.equal((await old).staleAdminRequest,true);assert.equal(f.client.stats().pendingReads,0);
});

test('a newer same-identity refresh replaces an older GET and preserves independent metadata requests',async()=>{
  const f=fixture();
  const old=f.client.request('/matches').catch(error=>error),metadata=f.client.request('/blinds'),fresh=f.client.request('/matches');
  assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.calls[1].options.signal.aborted,false);
  assert.equal(f.client.stats().pendingReads,2);
  f.calls[2].resolve(reply(['fresh']));f.calls[1].resolve(reply(['blinds']));f.calls[0].resolve(reply(['stale']));
  assert.deepEqual(await fresh,['fresh']);assert.deepEqual(await metadata,['blinds']);assert.equal((await old).staleAdminRequest,true);
  assert.equal(f.client.stats().pendingReads,0);
});

test('credentials changing while JSON is decoded also invalidate the earlier result',async()=>{
  const f=fixture();let finishJSON;
  const pending=f.client.request('/matches').catch(error=>error);
  f.calls[0].resolve({ok:true,json:()=>new Promise(resolve=>{finishJSON=resolve;})});
  await new Promise(resolve=>setImmediate(resolve));f.change({token:'other'});
  finishJSON({code:0,data:['stale']});assert.equal((await pending).staleAdminRequest,true);
  assert.equal(f.client.stats().pendingReads,0);
});

test('switching identity never aborts, retries or redirects an already submitted mutation',async()=>{
  const f=fixture();
  const pending=f.client.request('/tickets/1/issue','POST',{userId:42,count:1,requestId:'original'}).catch(error=>error);
  f.change({agent:'22',token:'agent-22'});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.signal.aborted,false);
  assert.equal(f.calls[0].options.headers['X-Agent-Id'],'11');assert.equal(f.calls[0].options.headers['X-Admin-Token'],'platform');
  assert.equal(JSON.parse(f.calls[0].options.body).requestId,'original');
  f.calls[0].resolve(reply({issued:1}));assert.equal((await pending).staleAdminRequest,true);assert.equal(f.calls.length,1);
});

test('timeouts and server errors release pending reads, with no automatic retry',async()=>{
  let attempts=0;
  const timeout=createAdminRequests({identity:()=>({token:'x',agent:'11'}),timeoutMs:5,send:(_url,{signal})=>{attempts++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}});
  await assert.rejects(timeout.request('/matches'),{name:'TimeoutError'});assert.equal(timeout.stats().pendingReads,0);assert.equal(attempts,1);
  const failed=createAdminRequests({identity:()=>({token:'x',agent:'11'}),send:async()=>({ok:false,json:async()=>({code:403,msg:'denied'})})});
  await assert.rejects(failed.request('/matches'),/denied/);assert.equal(failed.stats().pendingReads,0);
});

test('page disposal aborts reads, rejects old results and prevents new calls',async()=>{
  const f=fixture(),pending=f.client.request('/matches').catch(error=>error);
  f.client.dispose();assert.equal(f.calls[0].options.signal.aborted,true);assert.equal(f.client.stats().pendingReads,0);
  f.calls[0].resolve(reply([]));assert.equal((await pending).staleAdminRequest,true);
  await assert.rejects(f.client.request('/matches'),{staleAdminRequest:true});assert.equal(f.calls.length,1);
});
