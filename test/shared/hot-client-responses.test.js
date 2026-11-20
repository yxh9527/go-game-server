import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {clientResponseFixture} from '../fixtures/hot-client-responses.mjs';

function get(server,url){return new Promise((resolve,reject)=>http.get({host:'127.0.0.1',port:server.address().port,path:url},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));}).on('error',reject));}

test('the resident client listener adopts edited response adapters and an old app keeps its cached response',async()=>{
  const f=clientResponseFixture();let app;const server=http.createServer((req,res)=>app(req,res));let listening=false;
  const route='/assets/main/index.88f4e.js',sourceFile=new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),original=fs.readFileSync(sourceFile,'utf8');
  try{
    f.write(0);const first=(await f.load('app.js',0)).createClientApp();app=first;
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));listening=true;
    const before=await get(server,route);assert.equal(before.status,200);assert.notEqual(before.body,original);new vm.Script(before.body);
    const adapter=f.sources.find(item=>item.file.endsWith('holdem-replay-response.js'));
    adapter.source=adapter.source.replace('export function adaptHoldemReplayResponse(source) {',"export function adaptHoldemReplayResponse(source) { source+='\\n/* hot-response-new */';");
    f.write(1);app=(await f.load('app.js',1)).createClientApp();const after=await get(server,route);assert.equal(after.status,200);assert.match(after.body,/hot-response-new/);new vm.Script(after.body);
    app=first;assert.equal((await get(server,route)).body,before.body);assert.equal(fs.readFileSync(sourceFile,'utf8'),original);
  }finally{if(listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}f.close();}
});

test('replacing admin helpers does not replay pending mutations or release the original form lock',async()=>{
  const f=clientResponseFixture(),calls=[];let identity={token:'original',agent:'7'},client;
  try{
    f.write(0);const requests=await f.load('admin-requests.js',0),submissions=(await f.load('admin-submissions.js',0)).createAdminSubmissions();
    client=requests.createAdminRequests({identity:()=>identity,send:(url,options)=>new Promise(resolve=>calls.push({url,options,resolve}))});
    const saving=submissions.submit('match',()=>client.request('/matches','POST',{name:'original'}));assert.equal(calls.length,1);
    f.write(1);const nextRequests=await f.load('admin-requests.js',1),nextSubmissions=(await f.load('admin-submissions.js',1)).createAdminSubmissions();
    assert.notEqual(requests.createAdminRequests,nextRequests.createAdminRequests);assert.equal(submissions.submit('match',()=>assert.fail('original lock released')),false);assert.equal(submissions.stats().pendingForms,1);
    calls[0].resolve({ok:true,json:async()=>({code:0,data:{id:9}})});assert.deepEqual(await saving,{id:9});assert.equal(calls.length,1);assert.equal(submissions.stats().pendingForms,0);assert.equal(nextSubmissions.stats().pendingForms,0);
    const pending=client.request('/matches').catch(error=>error);identity={token:'changed',agent:'8'};client.sync();calls[1].resolve({ok:true,json:async()=>({code:0,data:[{agent:7}]})});assert.equal((await pending).staleAdminRequest,true);assert.equal(calls[1].options.signal.aborted,true);
  }finally{client?.dispose();f.close();}
});

test('new admin refresh factories keep page tickets separate across source replacement',async()=>{
  const f=clientResponseFixture();let view='matches';
  const options={view:()=>view,scope:()=>1,assertScope:value=>assert.equal(value,1),stale:()=>Object.assign(Error('stale'),{stale:true})};
  try{
    f.write(0);const old=(await f.load('admin-refresh.js',0)).createAdminRefresh(options),ticket=old.foreground();
    f.write(1);const next=(await f.load('admin-refresh.js',1)).createAdminRefresh(options);old.assertCurrent(ticket);assert.throws(()=>next.assertCurrent(ticket),{stale:true});
    view='blinds';assert.throws(()=>old.assertCurrent(ticket),{stale:true});old.finish(ticket);assert.deepEqual(old.stats(),{foregroundReads:0,backgroundReads:0});
  }finally{f.close();}
});

test('client response namespaces, mounted apps and admin factories can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-client-responses.mjs','--client-responses-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_CLIENT_RESPONSES_GC/);
});
