import test from 'node:test';
import assert from 'node:assert/strict';
import * as grpc from '@grpc/grpc-js';
import * as loader from '@grpc/proto-loader';
import {fileURLToPath} from 'node:url';
import {createLotteryTransport,resolveLotteryAddress} from '../../../shared/rpc/utils/lotteryGrpc.js';
import {CommonRpcProd} from '../../../shared/rpc/implementations/prod/commonRpcProd.js';
import {createGameRouteIndex,bindRoundGameRoute} from '../../../shared/rpc/game-routes.js';

test('finance RPC receives the mapped number over real gRPC, preserving decimal strings and business failures',async t=>{
  const file=fileURLToPath(new URL('../../../shared/rpc/proto/lottery.proto',import.meta.url));
  const definition=loader.loadSync(file,{keepCase:true,longs:String,enums:Number,defaults:true});
  const Service=grpc.loadPackageDefinition(definition).lottery.LotteryService;
  const received=[],server=new grpc.Server();
  server.addService(Service.service,{
    Bet(call,reply){received.push(call.request);reply(null,{code:0,roundId:call.request.roundId,state:'BETTING',betDigest:'server-digest',
      items:call.request.items.map(item=>({betId:item.betId,userId:item.userId,code:9,accepted:false,currency:'10.00',message:'NO_ENOUGH_MONEY'}))});},
    GetBalance(_call,reply){reply(null,{code:0,currency:'10.01',currencyCent:'1001'});},
    Settlement(call,reply){received.push(call.request);reply(null,{code:0,roundId:call.request.roundId,state:'SETTLED',settlementId:call.request.settlementId,items:[{userId:42,code:0,currency:'11.01'}]});},
  });
  const port=await new Promise((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createInsecure(),(e,p)=>e?reject(e):resolve(p)));
  const transport=createLotteryTransport(new Service('127.0.0.1:'+port,grpc.credentials.createInsecure()));
  t.after(async()=>{transport.close();await new Promise(resolve=>server.tryShutdown(resolve));});
  const owners=[],common=new CommonRpcProd({lottery:async agent=>{owners.push(agent);return transport;}});
  const index=createGameRouteIndex([{gameType:19,roomType:19,number:91001,symbol:'test_holdem',state:1,isFrozen:0}]);
  const round=bindRoundGameRoute({},index,{game_type:19,room_type:19});
  const response=await common.finance('bet',{requestId:'req-1',roundId:'test-round',agent:7,gameId:round.number,level:1,
    items:[{betId:'test-round:rev:0:1',userId:42,currencyType:'CNY',amount:'10.01',areaId:'blind',carry:{token:'seat',tableKey:'7:holdem:1',revision:5}}]});
  assert.equal(received[0].gameId,91001);assert.equal(received[0].items[0].amount,'10.01');
  assert.equal(response.code,0);assert.equal(response.items[0].accepted,false);assert.equal(response.items[0].code,9);
  assert.equal(received[0].items[0].carry.revision,'5');
  await common.finance('settlement',{agent:7,roundId:'test-net-round',gameId:91024,settlementId:'seat-net',mode:'SEAT_NET',items:[{userId:42,currencyType:'CNY',betAmount:'1.00',payout:'2.00',profit:'1.00',netScore:'1.00',pump:'0',carry:{token:'seat',tableKey:'7:niuniu:1',revision:6}}]});
  assert.equal(received[1].items[0].netScore,'1.00');assert.equal(received[1].items[0].carry.revision,'6');
  assert.equal(await common.getBalance(42,7),1001);assert.deepEqual(owners,[7,7,7]);
});

test('lottery writes require an explicit stable agent owner and transport timeouts stay uncertain',async()=>{
  assert.equal(resolveLotteryAddress({agents:{7:'node-a'},nodes:{'node-a':'127.0.0.1:10080'}},7),'127.0.0.1:10080');
  assert.throws(()=>resolveLotteryAddress({agents:{},nodes:{a:'node-a',b:'node-b'}},7),e=>e.code==='LOTTERY_ROUTE_MISSING');
  const client={Bet(_request,options,done){assert.ok(options.deadline instanceof Date);done(Object.assign(new Error('deadline'),{code:4}));}};
  await assert.rejects(()=>createLotteryTransport(client).bet({}),e=>e.uncertain&&e.status===504);
  const corrupt={GetBalance(_request,_options,done){done(null,{code:0,currency:'10.01',currencyCent:'1002'});}};
  const common=new CommonRpcProd({lottery:async()=>createLotteryTransport(corrupt)});
  await assert.rejects(()=>common.getBalance(42,7),/units disagree/);
});
