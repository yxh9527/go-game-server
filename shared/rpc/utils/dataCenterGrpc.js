import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const protoDir = path.join(here, "../proto");

export function createDataCenterTransport(client,{timeoutMs=3000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)throw new Error('Invalid data-center deadline');
  const methods=['Authenticate','GetLoginData','ValidateToken','GetPlayer','GetRecords','GetRecordDetail',
    'GetGameList','GetValue','SetValue','UpdatePlayerAvatarAndGender','UserLock','UserUnLock','GetSesson'];
  const result={close:()=>client.close?.()};
  for(const method of methods)result[method[0].toLowerCase()+method.slice(1)]=request=>new Promise((resolve,reject)=>{
    const invoke=client[method]||client[method[0].toLowerCase()+method.slice(1)];
    invoke.call(client,request,{deadline:new Date(Date.now()+timeoutMs)},(error,response)=>{
      if(error)return reject(Object.assign(error,{status:({3:400,5:404,7:403,4:504,12:503,14:503})[error.code]||503}));
      if(!response)return reject(Object.assign(new Error('Data-center returned no response'),{status:503}));
      resolve(response);
    });
  });
  return result;
}

let cached = null;
let opening;
export function closeDataCenterClient(){cached?.transport.close();cached=null;opening=null;}

export async function getDataCenterClient() {
  const address = String(env.config.data_center || env.config.dataCenter || "127.0.0.1:10081");
  const timeoutMs=Number(env.config.data_center_timeout_ms||3000),key=JSON.stringify([address,timeoutMs]);
  if(cached?.key===key)return cached.transport;
  if(opening?.key===key)return opening.promise;
  cached?.transport.close();cached=null;
  const attempt={key};
  attempt.promise=(async()=>{
  const grpc = await import("@grpc/grpc-js");
  const protoLoader = await import("@grpc/proto-loader");
  const def = protoLoader.loadSync(path.join(protoDir, "datacenter.proto"), {
    keepCase: true,
    longs: String,
    enums: Number,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  });
  const proto = grpc.loadPackageDefinition(def);
  const Service = proto.datacenter?.DataCenterService;
  if (!Service) {
    throw new Error("datacenter.DataCenterService not found");
  }
  const client = new Service(address, grpc.credentials.createInsecure(),{'grpc.max_receive_message_length':32*1024*1024,'grpc.max_send_message_length':32*1024*1024});
  const transport=createDataCenterTransport(client,{timeoutMs});
  if(opening!==attempt){transport.close();throw new Error('Data-center connection configuration changed');}
  cached={key,transport};return transport;
  })();
  opening=attempt;
  try{return await attempt.promise;}finally{if(opening===attempt)opening=null;}
}
