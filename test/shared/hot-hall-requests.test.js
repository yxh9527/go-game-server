import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocketServer} from 'ws';
import {spawnSync} from 'node:child_process';
import {hallRequestFixture} from '../fixtures/hot-hall-requests.mjs';
import {createMatchStore} from '../../hall/src/store.js';

test('pending fair-code and smart-task forwarding survives replacement without replaying a request',async()=>{
  const f=hallRequestFixture(),server=new WebSocketServer({port:0,host:'127.0.0.1'}),received=[],waiters=[];
  const nextMessage=()=>new Promise(resolve=>waiters.push(resolve));
  server.on('connection',socket=>socket.on('message',raw=>{const data=JSON.parse(raw);received.push({socket,data});waiters.shift()?.();}));
  await new Promise(resolve=>server.once('listening',resolve));
  const runtime={config:{game_server:'ws://127.0.0.1:'+server.address().port}};
  try{
    f.write(0);const oldFair=await f.load('fair-code.js',0),oldSmart=await f.load('smart-bet.js',0);
    let ready=nextMessage();const pending=oldFair.requestFairCode(runtime,{userId:42,token:'token',gameRoomId:7,currentInning:1});await ready;
    f.write(1);const fair=await f.load('fair-code.js',1),smart=await f.load('smart-bet.js',1);
    assert.notEqual(fair.requestFairCode,oldFair.requestFairCode);assert.notEqual(smart.smartBetRequest,oldSmart.smartBetRequest);
    assert.equal(received.length,1);assert.equal(received[0].data.action,'fair-code');assert.equal(received[0].data.userId,42);
    received[0].socket.send(JSON.stringify({type:'room-pool-result',code:200,data:{proof:'original'}}));
    assert.deepEqual((await pending).data,{proof:'original'});
    ready=nextMessage();const create=smart.smartBetRequest(runtime,{userId:42,token:'token',roomType:58,bizType:1,bizParam:JSON.stringify({roomType:58,strategy:'FIXED',operateType:1})});await ready;
    f.write(2);await f.load('smart-bet.js',2);assert.equal(received.length,2);
    assert.equal(received[1].data.action,'smart-bet');assert.equal(received[1].data.request.action,'create');
    received[1].socket.send(JSON.stringify({type:'room-pool-result',code:200,data:{taskId:'original-task'}}));
    assert.equal((await create).data.taskId,'original-task');
    assert.equal((await fair.requestFairCode(runtime,{userId:42,token:'token',gameRoomId:0,currentInning:1})).msgCode,400);
    assert.equal(received.length,2,'invalid proof request reached transport');
  }finally{for(const socket of server.clients)socket.terminate();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('match forwarding retains the resident snapshot store and never retries a rejected registration',async()=>{
  const f=hallRequestFixture(),store=createMatchStore(),calls=[];
  let fail=false,reply,arrived;
  const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push(JSON.parse(body));reply=()=>res.end(JSON.stringify(fail?{code:403,msg:'denied'}:{code:0,data:[]}));arrived?.();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime={env:'prod',config:{match_server:'http://127.0.0.1:'+server.address().port},matchStore:store};
  const params={userId:42,userToken:'token',championshipsConfigId:99,type:2};
  try{
    f.write(0);const old=await f.load('match-client.js',0);
    let ready=new Promise(resolve=>{arrived=resolve;});const pending=old.matchRequest(runtime,params,'register');await ready;
    f.write(1);const next=await f.load('match-client.js',1);assert.notEqual(old.matchRequest,next.matchRequest);assert.equal(calls.length,1);reply();await pending;
    fail=true;ready=new Promise(resolve=>{arrived=resolve;});const rejected=assert.rejects(next.matchRequest(runtime,params,'register'),error=>error.code===403);await ready;reply();await rejected;
    assert.equal(runtime.matchStore,store);assert.equal(calls.length,2);assert.deepEqual(calls[0],{action:'register',matchId:99,userId:42,token:'token',paymentType:2});
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));f.close();}
});

test('released hall forwarding namespaces and functions can be collected',()=>{
  const result=spawnSync(process.execPath,['--expose-gc','test/fixtures/hot-hall-requests.mjs','--hall-requests-gc'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/PASS_HALL_REQUESTS_GC/);
});
