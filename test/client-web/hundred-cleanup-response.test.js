import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import {createClientApp} from '../../client-web/src/app.js';
import {adaptHundredCleanupResponse,unregisterHundredRooms,unavailableCleanupSocket} from '../../client-web/src/hundred-cleanup-response.js';
const file=new URL('../../static/client/2.0.1279/assets/BairenMultyBet/index.74b50.js',import.meta.url);
const original=fs.readFileSync(file,'utf8'),adapted=adaptHundredCleanupResponse(original);
const protocol={Request:{MB_UNREG_ROOMS_REQ:6124},Response:{MB_UNREG_ROOMS_RES:6225}};
function fixture(){
  const listeners=new Map(),events=new Map(),sent=[];
  const notify={offByTargetName(id,target){if(listeners.get(id)?.target===target)listeners.delete(id);},
    on(id,callback,target){listeners.set(id,{callback,target});}};
  const raw={readyState:1,addEventListener(type,fn){events.set(type,fn);},removeEventListener(type,fn){if(events.get(type)===fn)events.delete(type);}};
  const socket={_socket:raw,getRoomSocketIsOpen:()=>true,send:id=>sent.push(id)},transport={roomSocket:socket},viewModel={};
  const run=()=>unregisterHundredRooms(viewModel,notify,protocol,transport,unavailableCleanupSocket);
  return {listeners,events,sent,notify,raw,socket,transport,viewModel,run};
}

test('cleanup completes when the native selector cannot find an available room server',async()=>{
  const src=original,anchor="Object['defineProperty'](P,'roomSocket',{'get':",start=src.indexOf(anchor)+anchor.length,end=src.indexOf(",'enumerable':",start);
  const getter=vm.runInNewContext('('+src.slice(start,end)+')',{
    G:{default:{canKiwi:false}},E:{default:{instance:{connectRoomData:{hundredDomain:'room.example:443'}}}},
    C:{default:{ins:{socketUrl:''}}},D:{default:{ins:{socketUrl:''}}},
    A:{default:{getUrlDomain:value=>value}},console:{log(){}},
  });
  const f=fixture();Object.defineProperty(f.transport,'roomSocket',{get:getter,configurable:true});
  assert.throws(()=>f.transport.roomSocket,/当前无可用房间服/,'reproduce the exact original getter failure');
  const marker="K['prototype']['sendUnregRoomsReq']=",a=adapted.indexOf(marker)+marker.length,b=adapted.indexOf(",K['prototype']['sendRoomBetReq']=",a);
  const native=vm.runInNewContext('('+adapted.slice(a,b)+')',{C:{default:f.notify},E:{BRMBDef:protocol},F:{default:f.transport}});
  assert.equal(await native.call(f.viewModel),0);assert.equal(f.listeners.size,0);assert.equal(f.sent.length,0);
});

test('healthy unregister waits for the real acknowledgement and coalesces repeated cleanup',async()=>{
  const f=fixture();const first=f.run(),second=f.run();assert.equal(first,second);
  assert.deepEqual(f.sent,[6124]);let resolved=false;first.then(()=>{resolved=true;});
  await Promise.resolve();assert.equal(resolved,false);
  f.listeners.get(6225).callback();assert.equal(await first,0);assert.equal(await second,0);
  assert.equal(f.listeners.size,0);assert.equal(f.events.size,0);assert.equal(f.viewModel.__gogameUnregister,undefined);
});

test('disconnect before cleanup and disconnect while waiting both finish without stale listeners',async()=>{
  for(const before of [false,true]){
    const f=fixture();if(before)f.raw.readyState=3;
    const task=f.run();
    if(!before){f.raw.readyState=3;f.events.get('close')();}
    assert.equal(await task,0);assert.equal(f.listeners.size,0);assert.equal(f.events.size,0);
    assert.equal(f.sent.length,before?0:1);
  }
});

test('cleanup handles a synchronous acknowledgement and never selects a replacement connection mid-request',async()=>{
  const f=fixture(),other=[];
  f.socket.send=id=>{f.sent.push(id);f.transport.roomSocket={send:value=>other.push(value)};f.listeners.get(6225).callback();};
  assert.equal(await f.run(),0);assert.deepEqual(f.sent,[6124]);assert.deepEqual(other,[]);
});

test('native notification dispatch completes cleanup even after the departing Cocos node was destroyed',async()=>{
  const main=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8');
  const begin=main.indexOf("'NotificationCenter':["),end=main.indexOf("'NotificationTime':[",begin),module=main.slice(begin,end);
  function native(name,next,context){
    const marker="h['"+name+"']=",a=module.indexOf(marker)+marker.length,b=module.indexOf(",h['"+next+"']=",a);
    return vm.runInNewContext('('+module.slice(a,b)+')',context);
  }
  class Component{constructor(){this.node={destroyed:true};}}
  let dropped=0,oldCallback=false;
  const notify={_handles:{},emit:native('emit','on',{cc:{Component,isValid:()=>false},d:args=>args.flat(),
    f:{default:{ReportLog(){dropped++;}}}}),
    on:native('on','off'),offByTargetName:native('offByTargetName','offTarget')};
  const owner=new Component();
  notify.on(6225,()=>{oldCallback=true;},owner);notify.emit(6225,{});
  assert.equal(oldCallback,false);assert.equal(dropped,1,'original callback ownership loses the acknowledgement');
  const f=fixture(),task=unregisterHundredRooms(owner,notify,protocol,f.transport,unavailableCleanupSocket);
  notify.emit(6225,{});assert.equal(await task,0);assert.equal(notify._handles[6225],undefined);
});

test('native auxiliary socket forwards cleanup acknowledgement in an ordinary room while filtering gameplay',()=>{
  const main=fs.readFileSync(new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8'),patched=adaptHundredCleanupResponse(main);
  assert.notEqual(patched,main);assert.equal(adaptHundredCleanupResponse(patched),patched);new vm.Script(patched);
  const a=patched.indexOf("'RoomSocket2':["),marker="l['prototype']['onMessageBack2']=",b=patched.indexOf(marker,a)+marker.length,c=patched.indexOf(",l;}",b);
  const forwarded=[],closed=[],state={isInBairenQpGame:false};
  const handle=vm.runInNewContext('('+patched.slice(b,c)+')',{
    h:{default:state},k:{prototype:{onMessageBack2(id,data){forwarded.push({id,data});}}},console:{log(){}},
  });
  const socket={close:value=>closed.push(value)},ack={};
  handle.call(socket,6225,ack);assert.deepEqual(forwarded,[{id:6225,data:ack}]);
  handle.call(socket,3850,{});assert.equal(forwarded.length,1,'ordinary rooms still ignore hundred gameplay pushes');
  handle.call(socket,1203,{});assert.deepEqual(closed,[true],'native invalid-login handling remains active');
  state.isInBairenQpGame=true;handle.call(socket,3850,{});assert.equal(forwarded[1].id,3850);
});

test('a delayed hundred-exit command is harmless after the native model is released',()=>{
  const source=adaptHundredCleanupResponse(fs.readFileSync(new URL('../../static/client/2.0.1279/assets/Bairen/index.85029.js',import.meta.url),'utf8'));
  const marker="D['prototype']['commandExit']=",a=source.indexOf(marker)+marker.length,b=source.indexOf(",D['prototype']['commandSetChipValue']=",a);
  const exit=vm.runInNewContext('('+source.slice(a,b)+')',{});let calls=0;
  assert.doesNotThrow(()=>exit.call({model:null}));
  exit.call({model:{exitRequest(){calls++;}}});assert.equal(calls,1);
});

test('only the two unavailable-connection failures are harmless during cleanup',async()=>{
  for(const message of ['当前无可用房间服','当前没有hundredDomain百人服地址, 无法连接百人服','unexpected protocol error']){
    const f=fixture();Object.defineProperty(f.transport,'roomSocket',{get(){throw new Error(message);}});
    if(message==='unexpected protocol error')await assert.rejects(f.run(),{message});
    else assert.equal(await f.run(),0);
    assert.equal(f.listeners.size,0);assert.equal(f.sent.length,0);
  }
  const f=fixture();f.socket.send=()=>{throw new Error('encoder failure');};
  await assert.rejects(f.run(),{message:'encoder failure'});assert.equal(f.listeners.size,0);assert.equal(f.events.size,0);
});

test('native cleanup response compiles, is idempotent, and serves both routes without rewriting static',async()=>{
  assert.notEqual(adapted,original);assert.equal(adaptHundredCleanupResponse(adapted),adapted);new vm.Script(adapted);
  const server=http.createServer(createClientApp());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const prefix of ['/2.0.1279','']){
      const response=await fetch('http://127.0.0.1:'+server.address().port+prefix+'/assets/BairenMultyBet/index.74b50.js');
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(await response.text(),adapted);
    }
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
