import { rel } from './rel.js';
import fs from 'node:fs';
const version = new URL(import.meta.url).searchParams.get('v') || '0';
const { requestRoomPool } = await rel(import.meta.url, './room-pool.js', version);
const { projectUserCenter } = await rel(import.meta.url, '../../shared/user-center.js', version);
const { userInfoOf } = await rel(import.meta.url, '../../game-server/src/core/member.js', version);

async function currentProjection(runtime) {
  const state=runtime.userCenterProjection ||= {version,project:projectUserCenter,dirty:false,loading:null};
  if(state.version!==version){state.version=version;state.project=projectUserCenter;}
  if(!state.watcher){
    state.watcher=fs.watch(new URL('../../shared/',import.meta.url),(_event,file)=>{
      if(String(file)==='user-center.js')state.dirty=true;
    });
    state.watcher.on('error',error=>runtime.log?.error?.('user-center projection watcher failed',error.message));
    state.watcher.unref();
  }
  if(state.dirty&&!state.loading){
    state.dirty=false;
    state.loading=rel(import.meta.url,'../../shared/user-center.js',version+'-'+Date.now())
      .then(mod=>{state.project=mod.projectUserCenter;})
      .catch(error=>{state.dirty=true;throw error;})
      .finally(()=>{state.loading=null;});
  }
  if(state.loading)await state.loading;
  return state.project;
}
const failure = (code,message) => Object.assign(new Error(message),{code});
const DAY = 86400000, OFFSET = 8*3600000;
function integer(value,fallback,min,max) {
  const n=value == null || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(n)||n<min||n>max)throw failure(400,'Invalid user-center pagination or filter');
  return n;
}
function timestamp(value) {
  if(value == null || value === '')return null;
  if(/^\d+$/.test(String(value))){const n=Number(value);if(Number.isSafeInteger(n)&&n>0)return n<100000000000?n*1000:n;}
  const parts=/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(String(value));
  if(!parts)throw failure(400,'Invalid user-center date');
  const [y,m,d,h,minute,s]=parts.slice(1).map(Number),utc=Date.UTC(y,m-1,d,h,minute,s);
  const date=new Date(utc);
  if(date.getUTCFullYear()!==y||date.getUTCMonth()!==m-1||date.getUTCDate()!==d||h>23||minute>59||s>59)throw failure(400,'Invalid user-center date');
  return utc-OFFSET;
}
export function userCenterQuery(op,params,now=Date.now()) {
  const page=integer(params.pageNum,1,1,1000),size=integer(params.pageSize,[39,40].includes(op)?15:10,1,100);
  if((page-1)*size>=10000)throw failure(400,'User-center page exceeds query limit');
  const today=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
  let startTime=timestamp(params.startTime),endTime=timestamp(params.endTime);
  if(startTime==null){const days=integer(params.startDateDiff,[28,31,52].includes(op)?30:0,0,30);startTime=today-days*DAY;}
  if(endTime==null){const days=integer(params.endDateDiff,0,0,30);endTime=days?today-(days-1)*DAY-1:now;}
  if(startTime>endTime||endTime-startTime>31*DAY)throw failure(400,'Invalid user-center date range');
  const kind=({39:'funds',40:'tickets',28:'hands',52:'round',31:'match',30:'matches'})[op] || 'battles';
  return {kind,page,size,startTime,endTime,roomId:integer(params.gameRoomId ?? params.id,0,0,Number.MAX_SAFE_INTEGER),
    inning:integer(params.currInning ?? params.inningNum,0,0,Number.MAX_SAFE_INTEGER),sortDesc:!String(params.sortRule || 'DESC').toUpperCase().endsWith('ASC'),
    roomType:integer(params.roomType,0,0,10000),privateRoom:params.privateRoom===true||params.privateRoom==='true'};
}

export async function userCenterResponse(runtime,op,params) {
  try {
    const gateway=runtime.gateway || runtime.rpc?.gateway,userId=integer(params.userId ?? params.uid,0,1,4294967295);
    const token=params.token || params.userToken;
    if(!gateway?.authenticate || !token)throw failure(401,'Missing login credentials');
    const auth=await gateway.authenticate(token,userId);
    if(!auth?.success || Number(auth.userId)!==userId)throw failure(401,'Invalid login credentials');
    if(params.uid != null && Number(params.uid)!==userId)throw failure(403,'Cannot view another player');
    const profile=await gateway.getLoginData(userId);
    if(!profile||!Number.isSafeInteger(Number(profile.agentId))||Number(profile.agentId)<0
      ||profile.userId!=null&&Number(profile.userId)!==userId)throw failure(403,'Invalid user-center account');
    const query={...userCenterQuery(op,params),userId,agentId:Number(profile.agentId),currency:profile.currency?.symbol || 'CNY'};
    let source;
    if(runtime.env==='dev'&&['matches','match'].includes(query.kind)){
      const configured=String(runtime.config.match_server||'127.0.0.1:11040'),base=configured.includes('://')?configured:'http://'+configured;
      const response=await fetch(new URL('/internal/v1/tournament',base),{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({action:'history',userId,token,query}),signal:AbortSignal.timeout(5000)});
      const body=await response.json();if(!response.ok||body.code!==0)throw failure(body.code||503,body.msg||'Tournament history unavailable');source=body.data;
    }else source=runtime.env==='dev'?await requestRoomPool(runtime,{userId,token},'user-center',query):await gateway.getUserCenter(query);
    if(!source || typeof source!=='object')throw failure(503,'User-center source unavailable');
    const project=await currentProjection(runtime);
    const data=project(source,query);
    if(data===null)throw failure(404,'User-center record not found');
    return {msgCode:200,errMsg:null,data};
  } catch(error) {
    runtime.log?.error?.('user center query failed',error.message);
    const code=error.status || (Number.isInteger(error.code)&&error.code>=400&&error.code<=599?error.code:503);
    return {msgCode:code,errMsg:error.message,data:null};
  }
}

export async function userCenterProfileResponse(runtime,params) {
  try {
    const userId=integer(params.userId ?? params.uid,0,1,4294967295),token=params.token||params.userToken;
    const gateway=runtime.gateway||runtime.rpc?.gateway;
    if(!gateway?.authenticate||!token)throw failure(401,'Missing login credentials');
    const auth=await gateway.authenticate(token,userId);
    if(!auth?.success||Number(auth.userId)!==userId)throw failure(401,'Invalid login credentials');
    if(params.uid!=null&&Number(params.uid)!==userId)throw failure(403,'Cannot view another player');
    const profile=await gateway.getLoginData(userId);
    if(!profile||profile.userId!=null&&Number(profile.userId)!==userId)throw failure(403,'Invalid user-center account');
    const info=userInfoOf({uid:userId,name:profile.userName??profile.name,
      icon:profile.imageUrl??profile.userIcon??profile.avatar??profile.icon});
    return {msgCode:200,errMsg:null,data:{playerId:userId,name:info.name,imageUrl:info.icon,
      clubId:Number(profile.clubId??profile.agentId)||0}};
  }catch(error){return {msgCode:error.code||503,errMsg:error.message,data:null};}
}
