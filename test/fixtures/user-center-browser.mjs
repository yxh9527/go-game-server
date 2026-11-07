import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createWallet } from '../../game-server/src/wallet/index.js';
import { createApp } from '../../hall/src/create-app.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import {isGameStaticHost,isHallApiPath,proxyToClientWeb} from '../../hall/src/static-proxy.js';

// Isolated real settlement for browser regression; never inserts display records.
export async function settledUserCenter() {
  const registry=createRegistry(),wallet=createWallet({mode:'local',local_balance:1000000});
  const gateway={authenticate:async(token,userId)=>({success:token==='valid',userId}),validateToken:async token=>token==='valid',
    getLoginData:async userId=>({userId,agentId:7,userName:'p'+userId,currency:{symbol:'CNY'}})};
  const configs=seedRooms().map(row=>({...row,robot_behavior:{joinProbability:0,leaveProbability:0}}));
  const runtime={env:'dev',hotVersion:'browser',registry,wallet,gateway,configs,findConfig,log:{info(){},error(){}}};
  const handler=await createHandler(runtime),peers=[];
  for(const uid of [101,102]){
    const ws={readyState:1,send:raw=>decodeFrame(raw)},send=(id,data)=>handler.onMessage(ws,encodeFrame(id,data));peers.push({uid,ws,send});
    await send(1105,{userId:uid,userToken:'valid',roomId:700000});await send(2102,{roomId:700000,roomType:19});await send(5003,{position:uid-101});
  }
  const table=registry.getTable(700000,7,'holdem');
  for(const peer of peers)await peer.send(5001,{carryIn:table.carryMin/100});
  table.startAt=0;await handler.tick();
  await peers.find(p=>p.uid===table.hand.actorUid).send(3162,{operation:6,operationData:0});
  const game=http.createServer(),sockets=new WebSocketServer({server:game});
  sockets.on('connection',ws=>{ws.on('message',raw=>void handler.onMessage(ws,raw));ws.on('close',()=>void handler.onClose(ws));});
  await new Promise(resolve=>game.listen(0,'127.0.0.1',resolve));
  const app=await createApp({env:'dev',hotVersion:'browser',gateway,config:{game_server:'127.0.0.1:'+game.address().port},log:{error(){}},
    matchStore:{listMatches:()=>[]},roomStore:{list:()=>configs}});
  const hall=http.createServer((req,res)=>{
    if(isGameStaticHost(req.headers.host)&&!isHallApiPath(req.url))proxyToClientWeb(req,res,'127.0.0.1:4000',runtime.log);
    else app(req,res);
  });await new Promise(resolve=>hall.listen(0,'127.0.0.1',resolve));
  return {origin:'http://lobby.localhost:'+hall.address().port,uid:101,token:'valid',close:async()=>{
    await Promise.all(peers.map(p=>handler.onClose(p.ws)));
    for(const ws of sockets.clients)ws.terminate();sockets.close();
    await Promise.all([new Promise(resolve=>game.close(resolve)),new Promise(resolve=>hall.close(resolve))]);
  }};
}
