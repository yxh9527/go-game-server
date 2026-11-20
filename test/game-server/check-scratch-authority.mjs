// Explicit cross-language fixture: actual Node protocol handlers, gRPC, Go
// finance code and Redis Lua. No resident server, live account or real DB.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {loadEnv,closeRpc} from '../../shared/rpc/index.js';
import {CommonRpcProd} from '../../shared/rpc/implementations/prod/commonRpcProd.js';
import {createRpcWallet} from '../../game-server/src/wallet/rpcWallet.js';
import {createRegistry,findConfig} from '../../game-server/src/registry.js';
import {createHandler} from '../../game-server/src/create-handler.js';
import {encodeFrame,decodeFrame} from '../../game-server/src/codec.js';
import {closeLotteryClients} from '../../shared/rpc/utils/lotteryGrpc.js';
import {closeGogameStorageClient} from '../../shared/rpc/utils/gogameStorageGrpc.js';

const root=fileURLToPath(new URL('../../',import.meta.url)),binary=path.join(root,'cache/scratch-rpc-fixture.exe');
if(!fs.existsSync(binary))throw Error('Compile lottery/unified fixture first with go test -c.');
const server=spawn(binary,['-test.run=^TestScratchRPCFixture$','-test.timeout=90s'],{
  windowsHide:true,env:{...process.env,GOGAME_SCRATCH_RPC_FIXTURE:'1'},stdio:['pipe','pipe','pipe']});
let logs='';server.stderr.on('data',data=>{logs+=data;});
try{
  const address=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Go fixture startup deadline: '+logs)),15000);
    server.stdout.on('data',data=>{logs+=data;const match=logs.match(/SCRATCH_TEST_RPC (127\.0\.0\.1:\d+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
    server.once('error',error=>{clearTimeout(timeout);reject(error);});server.once('exit',code=>{clearTimeout(timeout);reject(Error('Go fixture exit '+code+': '+logs));});
  });
  loadEnv({env:'prod',data_center:address,data_center_token:'scratch-fixture-token',lottery:{address},lottery_timeout_ms:10000});
  // Isolated display-query fixture: history must travel through the data-center
  // gateway, never the lottery Redis-history RPC. Real ES is tested separately.
  const indexed=[],historyQueries=[],common=new CommonRpcProd(),gateway={validateToken:async()=>true,getLoginData:async uid=>({userId:uid,agentId:7,userName:'fixture-'+uid,currency:{symbol:'CNY'}}),writeUserCenter:async()=>true,
    getScratchHistory:async query=>{historyQueries.push(query);return {records:indexed.filter(r=>r.agentId===query.agentId&&r.userId===query.userId&&r.currency===query.currency&&r.roomType===query.roomType&&r.roomId===query.roomId).toReversed()};}};
  const configs=[61,63].map(type=>({game_type:1004,room_type:type,game_room_config_id:type*100+1,room_index:26,play_mode:0,state:1,finance_level:1,hundred_max_bet:10000}));
  const rpc={common,gateway,lobby:{async listFinanceGames(){return configs.map(c=>({gameType:1004,roomType:c.room_type,number:91000+c.room_type,symbol:c.room_type===61?'fixture-mj':'fixture-queen',state:1,isFrozen:0}));}}};
  const runtime={env:'prod',hotVersion:'scratch-rpc-before',config:{finance:{provider:'lottery',room_types:[53]}},rpc,gateway,
    wallet:createRpcWallet(rpc),registry:createRegistry(),configs,findConfig,log:{info(){},warn(){},error(...args){logs+=args.join(' ')+'\n';}}};
  let handler=await createHandler(runtime);
  async function connect(type,uid=42){
    const frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw)),close(){this.readyState=3;}};
    const roomId=(type*100+1)*10000+26;
    const send=async(id,body={})=>{await handler.onMessage(ws,encodeFrame(id,body));return frames.at(-1);};
    await send(1105,{userId:uid,userToken:'fixture-'+uid,deviceId:'fixture',roomId});await send(2102,{roomId,roomType:type});await send(2111,{});
    assert.equal(runtime.registry.session(ws)?.inRoom,true,'actual native login/join');
    return {ws,frames,send,async request(id,responseId,body={}){const start=frames.length;await send(id,body);const response=frames.slice(start).find(frame=>frame.msgid===responseId);assert.ok(response,'native response '+responseId);return response.payload;}};
  }
  for(const type of [61,63]){
    const socket=await connect(type),kind=type===61?'ggl1':'ggl2';
    const before=await common.getBalance(42,7);
    const instant=await socket.request(3701,3713,{faceValue:100,kind,revealMode:'RANDOM_BUY_REVEAL',serialFull:''});
    assert.equal(instant.code,0,JSON.stringify(instant));assert.equal(await common.getBalance(42,7),before-100+instant.winAmount);
    const duplicate=await socket.request(3701,3713,{faceValue:10000,kind,revealMode:'SPECIFIED',serialFull:instant.serialFull});
    assert.equal(duplicate.code,0);assert.equal(duplicate.faceValue,100);assert.equal(duplicate.winAmount,instant.winAmount);
    assert.equal(await common.getBalance(42,7),before-100+instant.winAmount);
    const search=await socket.request(3703,3714,{kind,searchType:'BOOK_TAIL',bookTail:'789'});assert.equal(search.code,0);
    const purchase=await socket.request(3704,3712,{kind,faceValue:200,purchaseMode:'FULL_BOOK',bookId7List:[search.matchedSerials[0]]});
    assert.equal(purchase.code,0);assert.equal(purchase.newTickets.length,20);assert.ok(purchase.newTickets.every(ticket=>!('huMask'in ticket)&&!('winAmount'in ticket)));
    runtime.hotVersion='scratch-rpc-after-'+type;handler=await createHandler(runtime);
    const state=await socket.request(3702,3711);assert.equal(state.code,0);assert.equal(state.pendingTickets.length,20);
    const owned=state.pendingTickets[0].serialFull,balance=await common.getBalance(42,7);
    const reveal=await socket.request(3701,3713,{kind,revealMode:'SPECIFIED',serialFull:owned,faceValue:10000});
    assert.equal(reveal.code,0);assert.equal(reveal.faceValue,200);assert.equal(await common.getBalance(42,7),balance+reveal.winAmount);
    indexed.push({agentId:7,userId:42,currency:'CNY',gameId:91000+type,roomType:type,roomId:reveal.purchaseRoomId,
      log:JSON.stringify({roomType:type,roomId:reveal.purchaseRoomId,gameRoomId:reveal.purchaseGameRoomId,serialNo:owned,faceValue:reveal.faceValue,amount:reveal.winAmount-reveal.faceValue,huMask:reveal.huMask,huCount:reveal.huCount,multiplier:reveal.multiplier})});
    const thief=await connect(type,43);const stolen=await thief.request(3701,3713,{kind,revealMode:'SPECIFIED',serialFull:owned});
    assert.notEqual(stolen.code,0);assert.equal(await common.getBalance(43,7),1000000);
    const history=await socket.request(6121,6221,{roomType:type});assert.ok(history.winInfo.some(record=>record.serialNo===owned));
    assert.equal(historyQueries.at(-1).roomType,type);assert.equal(historyQueries.at(-1).gameId,91000+type);
    console.log('PASS_SCRATCH_AUTHORITY',JSON.stringify({roomType:type,instant:true,book:20,pendingAfterReload:20,repeatPaidOnce:true,ownership:true}));
  }
  console.log('PASS_SCRATCH_NODE_GO_RPC');
}catch(error){console.error(logs.slice(-6000));throw error;}
finally{
  await closeLotteryClients();closeGogameStorageClient();await closeRpc();loadEnv({env:'dev'});
  server.stdin.end('\n');
}
