import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const controlError = (status,message) => Object.assign(new Error(message),{status});
export function signControl(secret,payload,at=Date.now()) {
  if (!secret) throw controlError(503,'未配置比赛服务间签名密钥');
  const content=JSON.stringify({at,nonce:randomUUID(),payload});
  return {type:'tournament-control',content,signature:createHmac('sha256',secret).update(content).digest('hex')};
}
export function verifyControl(secret,body,at=Date.now()) {
  if (!secret || typeof body.content!=='string' || !/^[a-f0-9]{64}$/.test(body.signature||'')) throw controlError(403,'比赛调度签名无效');
  const expected=createHmac('sha256',secret).update(body.content).digest();
  if (!timingSafeEqual(expected,Buffer.from(body.signature,'hex'))) throw controlError(403,'比赛调度签名无效');
  const doc=JSON.parse(body.content);
  if (!Number.isSafeInteger(doc.at)||Math.abs(at-doc.at)>30000||typeof doc.nonce!=='string') throw controlError(403,'比赛调度请求已过期');
  return doc.payload;
}
export function requestControl(address,secret,payload) {
  if(!address) throw controlError(503,'未配置比赛游戏服地址');
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(/^wss?:\/\//.test(address)?address:'ws://'+address);
    const timer=setTimeout(()=>finish(controlError(503,'比赛游戏服请求超时')),5000);
    let done=false;
    function finish(error,data){if(done)return;done=true;clearTimeout(timer);ws.close();error?reject(error):resolve(data);}
    ws.on('open',()=>{try{ws.send(JSON.stringify(signControl(secret,payload)));}catch(error){finish(error);}});
    ws.on('error',error=>finish(controlError(503,error.message)));
    ws.on('close',()=>finish(controlError(503,'比赛游戏服连接关闭')));
    ws.on('message',raw=>{try{const r=JSON.parse(String(raw));if(r.code!==200)throw controlError(r.code||503,r.error||'比赛调度失败');finish(null,r.data);}catch(error){finish(error);}});
  });
}
