import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocket,WebSocketServer} from 'ws';
import {attachGameProxy} from '../../hall/src/game-proxy.js';
import {MAX_FRAME_BYTES} from '../../game-server/src/codec.js';

async function fixture(t,delayUpgrade=false){
  const target=http.createServer(),held=new Set();
  let upstream;
  if(delayUpgrade)target.on('upgrade',(_req,socket)=>{held.add(socket);socket.on('close',()=>held.delete(socket));});
  else upstream=new WebSocketServer({server:target});
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  const hall=http.createServer(),proxy=attachGameProxy(hall,'127.0.0.1:'+target.address().port,{info(){},error(){}});
  await new Promise(resolve=>hall.listen(0,'127.0.0.1',resolve));
  const client=new WebSocket('ws://127.0.0.1:'+hall.address().port);client.on('error',()=>{});
  t.after(async()=>{
    client.terminate();for(const peer of proxy.clients)peer.terminate();for(const peer of upstream?.clients||[])peer.terminate();
    for(const socket of held)socket.destroy();
    proxy.close();upstream?.close();
    await Promise.all([new Promise(resolve=>hall.close(resolve)),new Promise(resolve=>target.close(resolve))]);
  });
  return {client,proxy,upstream};
}

test('proxy relays normal packets and preserves intentional upstream close information',async t=>{
  const f=await fixture(t);
  f.upstream.on('connection',peer=>peer.on('message',(data,binary)=>{peer.send(data,{binary});peer.close(1000,'intentional close');}));
  const echo=new Promise(resolve=>f.client.once('message',data=>resolve(data.toString())));
  const closed=new Promise(resolve=>f.client.once('close',(code,reason)=>resolve({code,reason:reason.toString()})));
  await new Promise(resolve=>f.client.once('open',resolve));f.client.send('test message');
  assert.equal(await echo,'test message');assert.deepEqual(await closed,{code:1000,reason:'intentional close'});
});
test('upstream handshake delays cannot accumulate unlimited queued player messages',async t=>{
  const f=await fixture(t,true);
  const closed=new Promise(resolve=>f.client.once('close',code=>resolve(code)));
  await new Promise(resolve=>f.client.once('open',resolve));
  for(let i=0;i<80;i++)f.client.send(Buffer.alloc(20000));
  assert.equal(await closed,1008);
});
test('oversized first packets close only the offending proxy connection',async t=>{
  const f=await fixture(t,true);
  const closed=new Promise(resolve=>f.client.once('close',code=>resolve(code)));
  await new Promise(resolve=>f.client.once('open',resolve));f.client.send(Buffer.alloc(MAX_FRAME_BYTES+1));
  assert.equal(await closed,1009);
});
