// Isolated protocol stress only. No resident sockets, database, real wallet,
// or running production service is used by this test.
import http from 'node:http';
import fs from 'node:fs';
import {monitorEventLoopDelay,performance} from 'node:perf_hooks';
import {WebSocket,WebSocketServer} from 'ws';
import {createHandler} from '../../game-server/src/create-handler.js';
import {createRegistry} from '../../game-server/src/registry.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {rel} from '../../shared/hot-import.js';
const {loadGames}=await rel(import.meta.url,'../../game-server/src/games/catalog.js','load-canonical');

const duration=Number(process.argv.find(a=>a.startsWith('--seconds='))?.split('=')[1]||120);
const concurrent=Number(process.argv.find(a=>a.startsWith('--clients='))?.split('=')[1]||100);
const registry=createRegistry(),runtime={env:'dev',hotVersion:'load-start',registry,configs:[],findConfig:()=>null,
  wallet:{authoritative:true,run(){throw Error('heartbeat touched monetary transaction');}},log:{info(){},warn(){},error(){}}};
const handler=await createHandler(runtime),server=http.createServer(),wss=new WebSocketServer({server});
let nextUser=1;const errors=[],clients=[],samples=[];
wss.on('connection',socket=>{
  registry.bind(socket,{userId:nextUser++,agentId:7,authenticated:true,inRoom:false});
  socket.on('message',data=>void handler.onMessage(socket,data).catch(e=>errors.push(e.message)));
  // No accepted bets/carry in this harness: removing the synthetic login is
  // sufficient and avoids invoking an authoritative wallet on test shutdown.
  socket.on('close',()=>registry.drop(socket));socket.on('error',()=>{});
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const loop=monitorEventLoopDelay({resolution:20});loop.enable();
const ping=encodeFrame(1200);let requests=0,reloads=0;
try{
  await Promise.all(Array.from({length:concurrent},async()=>{
    const client=new WebSocket('ws://127.0.0.1:'+server.address().port);
    client.on('error',e=>errors.push(e.message));await new Promise(resolve=>client.once('open',resolve));
    clients.push(client);
  }));
  await loadGames('load-warm');global.gc?.();
  const started=performance.now();let lastSample=0,lastReload=0;
  while(performance.now()-started<duration*1000){
    const elapsed=performance.now()-started;
    await Promise.all(clients.map(client=>new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('heartbeat deadline exceeded')),5000);
      client.once('message',data=>{clearTimeout(timer);if(!decodeFrame(data))return reject(Error('bad frame'));requests++;resolve();});
      client.send(ping);
    })));
    if(elapsed-lastReload>=2000){await loadGames('load-reload-'+(++reloads));lastReload=elapsed;}
    if(elapsed-lastSample>=10000||lastSample===0){
      global.gc?.();const sample={seconds:Math.round(elapsed/1000),heapBytes:process.memoryUsage().heapUsed,sessions:registry.sessions.size,requests,reloads};
      samples.push(sample);console.log(JSON.stringify(sample));lastSample=elapsed||1;
    }
    await new Promise(resolve=>setTimeout(resolve,20));
  }
}finally{
  loop.disable();
  const closing=[...wss.clients].map(socket=>new Promise(resolve=>socket.once('close',resolve)));
  for(const client of clients)client.terminate();
  for(const socket of wss.clients)socket.terminate();
  await Promise.all(closing);
  wss.close();await new Promise(resolve=>server.close(resolve));await new Promise(resolve=>setImmediate(resolve));global.gc?.();
  const result={scope:'isolated heartbeat plus unchanged-content hot import',durationSeconds:duration,clients:concurrent,requests,reloads,
    heapSamples:samples,afterCloseHeapBytes:process.memoryUsage().heapUsed,remainingSessions:registry.sessions.size,
    eventLoopP99Ms:loop.percentile(99)/1e6,eventLoopMaxMs:loop.max/1e6,errors};
  fs.writeFileSync('cache/three-fixes-load.json',JSON.stringify(result,null,2));console.log('LOAD_RESULT',JSON.stringify(result));
  if(errors.length||registry.sessions.size)process.exitCode=1;
}
