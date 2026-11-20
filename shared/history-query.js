import {createHash} from 'node:crypto';

const kinds=new Set(['battles','hands','round','room','funds','tickets','matches','match','replay']);
const invalid=()=>Object.assign(new Error('无效历史查询参数'),{status:400});
function integer(value,fallback,min,max){
  if(value==null)value=fallback;
  if(typeof value!=='number'&&(typeof value!=='string'||!/^\d+$/.test(value)))throw invalid();
  const n=Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw invalid();return n;
}
function boolean(value,fallback){
  if(value==null)return fallback;
  if(value===true||value==='true')return true;
  if(value===false||value==='false')return false;
  throw invalid();
}
function normalize(input){
  if(!kinds.has(input?.kind)||typeof input.currency!=='string'||!/^[A-Z0-9]{1,12}$/.test(input.currency))throw invalid();
  const query={kind:input.kind,userId:integer(input.userId,0,1,4294967295),agentId:integer(input.agentId,undefined,0,4294967295),currency:input.currency,
    page:integer(input.page,1,1,1000),size:integer(input.size,20,1,100),roomType:integer(input.roomType,0,0,10000),
    roomId:integer(input.roomId,0,0,Number.MAX_SAFE_INTEGER),inning:integer(input.inning,0,0,Number.MAX_SAFE_INTEGER),
    inningFrom:integer(input.inningFrom,0,0,Number.MAX_SAFE_INTEGER),inningTo:integer(input.inningTo,0,0,Number.MAX_SAFE_INTEGER),
    sortDesc:boolean(input.sortDesc,true),privateRoom:boolean(input.privateRoom,false),
    startTime:integer(input.startTime,0,1,Number.MAX_SAFE_INTEGER),endTime:integer(input.endTime,0,1,Number.MAX_SAFE_INTEGER)};
  if(boolean(input.allInnings,false)){
    if(query.kind!=='replay'||query.roomId<=0||query.page!==1||![0,19,101].includes(query.roomType))throw invalid();
    query.allInnings=true;
  }
  if((query.page-1)*query.size>=10000||query.endTime<query.startTime||query.endTime-query.startTime>31*86400000
    ||query.inningFrom&&query.inningTo&&query.inningFrom>query.inningTo)throw invalid();
  return query;
}
function validResult(value,kind){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.error||value.success===false||value.code!=null&&value.code!==0)return false;
  if(value.total!=null&&(!Number.isSafeInteger(value.total)||value.total<0))return false;
  if(kind==='funds'||kind==='tickets')return Array.isArray(value.logs);
  if(kind==='matches')return Array.isArray(value.matches);
  if(kind==='match')return Object.hasOwn(value,'match')&&(value.match===null||typeof value.match==='object'&&!Array.isArray(value.match));
  return Array.isArray(value.records);
}

// Only authenticated, normalized server-side queries are passed here. This is
// a short-lived request result cache, never a second materialized history.
export async function queryHistory(runtime,input,{relativeWindowMs,rollingEnd=false}={}){
  const query=normalize(input);
  const canonical={...query};
  if(typeof rollingEnd!=='boolean')throw invalid();
  if(relativeWindowMs!=null){
    const window=integer(relativeWindowMs,0,1,31*86400000);
    if(query.endTime-query.startTime!==window||rollingEnd)throw invalid();
    delete canonical.startTime;delete canonical.endTime;canonical.windowMs=window;
  }else if(rollingEnd){
    // Keep the original start, including the China calendar-day boundary.
    // Explicit end dates always keep their exact value in the key.
    delete canonical.endTime;canonical.rollingEnd=true;
  }
  const key='history-query:v3:'+createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const state=runtime.historyQueries||={pending:new Map()};
  state.owners||=new Map();
  if(state.pending.has(key))return state.pending.get(key);
  const owner=[query.agentId,query.userId,query.currency].join(':');
  if(state.pending.size>=32||(state.owners.get(owner)||0)>=4)throw Object.assign(new Error('历史查询繁忙，请稍后重试'),{status:503});
  const bus=runtime.rpc?.bus||runtime.bus,gateway=runtime.gateway||runtime.rpc?.gateway;
  const task=(async()=>{
    try{const raw=await bus?.getCache?.(key);if(raw){const value=JSON.parse(raw);if(validResult(value,query.kind))return value;}}catch{}
    if(!gateway?.getUserCenter)throw Object.assign(new Error('正式历史查询未配置'),{status:503});
    const value=await gateway.getUserCenter(query);
    if(!validResult(value,query.kind))throw Object.assign(new Error('正式历史返回无效数据'),{status:503});
    try{await bus?.setCache?.(key,JSON.stringify(value),180);}catch{}
    return value;
  })();
  state.pending.set(key,task);
  state.owners.set(owner,(state.owners.get(owner)||0)+1);
  try{return await task;}finally{if(state.pending.get(key)===task)state.pending.delete(key);const count=(state.owners.get(owner)||1)-1;if(count)state.owners.set(owner,count);else state.owners.delete(owner);}
}
