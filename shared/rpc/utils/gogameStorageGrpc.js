import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {env} from '../env.js';

const protoFile=fileURLToPath(new URL('../proto/gogame.proto',import.meta.url));
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const rpcError=error=>Object.assign(error,{status:({3:400,5:404,7:403,8:413,9:409,12:503,14:503,4:504})[error.code]||503});
let cached;
let opening;

export function createStorageTransport(client,{metadata,timeoutMs=10000,transactionTimeoutMs=60000}={}) {
  const options=duration=>({deadline:new Date(Date.now()+duration)});
  return {
    call(operation,payload={}) {
      return new Promise((resolve,reject)=>{
        client.Call({operation,payload:JSON.stringify(payload)},metadata,options(timeoutMs),(error,response)=>{
          if(error)return reject(rpcError(error));
          try{resolve(JSON.parse(response.payload));}catch{reject(fail('data-center 返回无效的存储数据'));}
        });
      });
    },
    withMatch(id,work) {
      return new Promise((resolve,reject)=>{
        const stream=client.MatchTransaction(metadata,options(transactionTimeoutMs));
        let value,stage='begin',done=false,chain=Promise.resolve();
        function finish(error) {
          if(done)return;done=true;
          if(error){stream.cancel();reject(error);}else resolve(value);
        }
        stream.on('error',error=>finish(rpcError(error)));
        stream.on('data',message=>{
          chain=chain.then(async()=>{
            if(done)return;
            if(message.phase==='absent'&&stage==='begin'){
              if(JSON.parse(message.payload)!==null)throw fail('data-center 比赛缺失响应无效');
              stage='absent';value=null;stream.end();return;
            }
            if(message.phase==='snapshot'&&stage==='begin'){
              const tx=JSON.parse(message.payload);
              if(Number(tx.row?.id)!==Number(id)||!tx.state||!tx.state.registrations||!Array.isArray(tx.state.outbox))throw fail('data-center 比赛事务快照无效');
              stage='working';value=await work(tx);
              if(done)return;
              stage='commit';stream.write({operation:'commit',payload:JSON.stringify(tx)});stream.end();return;
            }
            if(message.phase==='committed'&&stage==='commit'){stage='committed';return;}
            throw fail('data-center 比赛事务消息顺序无效');
          }).catch(finish);
        });
        stream.on('end',()=>{chain.then(()=>finish(['committed','absent'].includes(stage)?null:fail('比赛事务未确认提交，需按权威状态重试'))).catch(finish);});
        stream.write({operation:'begin',payload:JSON.stringify({id:Number(id)})});
      });
    },
    close(){client.close();},
  };
}

export async function getGogameStorageClient() {
  const address=String(env.config.data_center||env.config.dataCenter||'127.0.0.1:50051');
  const token=String(env.config.data_center_token||process.env.GOGAME_DATA_CENTER_TOKEN||'');
  if(!token)throw fail('未配置 data-center 业务存储凭证');
  if(cached&&cached.address===address&&cached.token===token)return cached.transport;
  if(opening&&opening.address===address&&opening.token===token)return opening.promise;
  cached?.transport.close();
  const attempt={address,token};
  attempt.promise=(async()=>{
    const grpc=await import('@grpc/grpc-js'),loader=await import('@grpc/proto-loader');
    const definition=loader.loadSync(protoFile,{keepCase:true,longs:String,defaults:true,includeDirs:[path.dirname(protoFile)]});
    const Service=grpc.loadPackageDefinition(definition).datacenter.GogameStorageService;
    const client=new Service(address,grpc.credentials.createInsecure(),{'grpc.max_receive_message_length':32*1024*1024,'grpc.max_send_message_length':32*1024*1024});
    const metadata=new grpc.Metadata();metadata.set('x-gogame-storage-token',token);
    const transport=createStorageTransport(client,{metadata});
    cached={address,token,transport};return transport;
  })();
  opening=attempt;
  try{return await attempt.promise;}finally{if(opening===attempt)opening=null;}
}
export function closeGogameStorageClient(){cached?.transport.close();cached=null;}
