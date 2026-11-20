import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {env} from '../env.js';

const protoFile=fileURLToPath(new URL('../proto/lottery.proto',import.meta.url));
const methods=['Bet','PrePay','RenewReservation','Settlement','GetRoundFinanceState','CancelBet','GetPoolControlDecision','GetBalance','ScratchAction'];
const transports=new Map();
const failure=(message,code='LOTTERY_UNAVAILABLE',status=503)=>Object.assign(new Error(message),{code,status});

// A write owner is explicit. Silently redistributing an agent when a node fails
// would violate the backend's single-writer requirement for pool statistics.
export function resolveLotteryAddress(config,agent){
  if(typeof config==='string'&&config.trim())return config.trim();
  if(config?.address)return String(config.address);
  const node=config?.agents?.[String(agent)];
  if(node!==undefined&&config?.nodes?.[node])return String(config.nodes[node]);
  throw failure('Lottery endpoint or agent write owner is not configured','LOTTERY_ROUTE_MISSING');
}

export function createLotteryTransport(client,{timeoutMs=3000,metadata}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid RPC deadline');
  const result={};
  for(const method of methods)result[method[0].toLowerCase()+method.slice(1)]=request=>new Promise((resolve,reject)=>{
    const invoke=client[method]||client[method[0].toLowerCase()+method.slice(1)];
    if(typeof invoke!=='function')return reject(failure('Lottery RPC is missing: '+method,'LOTTERY_PROTOCOL_MISSING'));
    const callback=(error,response)=>{
      if(error)return reject(Object.assign(error,{status:({3:400,7:403,8:429,9:409,4:504,12:503,14:503})[error.code]||503,
        uncertain:[1,2,4,13,14].includes(error.code)}));
      if(!response||!Number.isInteger(response.code))return reject(failure('Lottery response has no business code','LOTTERY_RESPONSE_INVALID'));
      resolve(response);
    };
    const options={deadline:new Date(Date.now()+timeoutMs)};
    if(metadata)invoke.call(client,request,metadata,options,callback);
    else invoke.call(client,request,options,callback);
  });
  result.close=()=>client.close?.();
  return result;
}

export async function getLotteryClient(agent){
  const address=resolveLotteryAddress(env.config.lottery??process.env.GOGAME_LOTTERY_ADDRESS,agent);
  const timeoutMs=Number(env.config.lottery_timeout_ms||3000);
  const key=JSON.stringify([address,timeoutMs]);
  if(!transports.has(key)){
    const opening=(async()=>{
      const grpc=await import('@grpc/grpc-js'),loader=await import('@grpc/proto-loader');
      const definition=loader.loadSync(protoFile,{keepCase:true,longs:String,enums:Number,defaults:true,includeDirs:[path.dirname(protoFile)]});
      const Service=grpc.loadPackageDefinition(definition).lottery.LotteryService;
      const client=new Service(address,grpc.credentials.createInsecure(),{'grpc.max_receive_message_length':32*1024*1024,'grpc.max_send_message_length':32*1024*1024});
      return createLotteryTransport(client,{timeoutMs,metadata:new grpc.Metadata()});
    })();
    transports.set(key,opening);opening.catch(()=>{if(transports.get(key)===opening)transports.delete(key);});
  }
  return transports.get(key);
}
export async function closeLotteryClients(){
  const pending=[...transports.values()];transports.clear();
  await Promise.allSettled(pending.map(async transport=>(await transport).close()));
}
