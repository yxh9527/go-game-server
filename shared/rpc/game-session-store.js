import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const GAME_SESSION_CHANNEL='gogame:game-session:v1';
export const GAME_SESSION_TTL_MS=30000;
export const GAME_SESSION_OPERATION_TTL_MS=30000;
const UNLOCK_SCRIPT="if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const RENEW_LOCK_SCRIPT="if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";

export const GAME_SESSION_SCRIPT=String.raw`
local raw=redis.call('GET',KEYS[1])
local old=raw and cjson.decode(raw) or nil
local action=ARGV[1]
local input=cjson.decode(ARGV[2])
local ttl=tonumber(ARGV[3])
local channel=ARGV[4]
local function owns(record)
  if not record or record.loginId~=input.loginId then return false end
  if record.primary and record.primary.socketId==input.socketId then return true end
  for _,peer in ipairs(record.paired or {}) do if peer.socketId==input.socketId then return true end end
  return false
end
if action=='claim' then
  local latest=tonumber(redis.call('GET',KEYS[3]) or '0')
  if tonumber(input.attempt or 0)<latest then return cjson.encode({ok=false,stale=true}) end
  if input.allowPair and old and old.primary and old.primary.inRoom
    and old.primary.identity==input.identity and old.primary.roomId==input.roomId
    and old.primary.gameId==input.gameId
    and (old.primary.roomType==19 or old.primary.roomType==24 or old.primary.roomType==25
      or old.primary.roomType==26 or old.primary.roomType==31) and #old.paired==0 then
    input.loginId=old.loginId
    input.generation=old.generation
    input.role='hundred'
    table.insert(old.paired,input)
    redis.call('SET',KEYS[1],cjson.encode(old),'PX',ttl)
    return cjson.encode({ok=true,loginId=old.loginId,generation=old.generation,role='hundred'})
  end
  local generation=redis.call('INCR',KEYS[2])
  local revoked=old and old.loginId or ''
  input.generation=generation
  input.role='primary'
  local next={loginId=input.loginId,generation=generation,primary=input,paired={}}
  redis.call('SET',KEYS[1],cjson.encode(next),'PX',ttl)
  if revoked~='' then redis.call('PUBLISH',channel,cjson.encode({event='revoke',loginId=revoked,reason='replaced'})) end
  return cjson.encode({ok=true,loginId=input.loginId,generation=generation,role='primary',revokedLoginId=revoked})
end
if action=='verify' then return owns(old) and '1' or '0' end
if action=='renew' then
  if not owns(old) then return '0' end
  redis.call('PEXPIRE',KEYS[1],ttl)
  return '1'
end
if action=='update' then
  if not old or old.loginId~=input.loginId or not old.primary or old.primary.socketId~=input.socketId then return '0' end
  old.primary.inRoom=input.inRoom
  old.primary.roomId=input.roomId
  old.primary.gameId=input.gameId
  old.primary.roomType=input.roomType
  redis.call('SET',KEYS[1],cjson.encode(old),'PX',ttl)
  return '1'
end
if action=='release' then
  if not old or old.loginId~=input.loginId then return '0' end
  if old.primary and old.primary.socketId==input.socketId then
    redis.call('DEL',KEYS[1])
    if #old.paired>0 then redis.call('PUBLISH',channel,cjson.encode({event='revoke',loginId=old.loginId,reason='primary-closed'})) end
    return '1'
  end
  local paired={}
  for _,peer in ipairs(old.paired or {}) do if peer.socketId~=input.socketId then table.insert(paired,peer) end end
  old.paired=paired
  if #paired==0 then redis.call('DEL',KEYS[1]) else redis.call('SET',KEYS[1],cjson.encode(old),'PX',ttl) end
  return '1'
end
return redis.error_reply('GAME_SESSION_ACTION')
`;

export function createInMemoryGameSessionBackend(){
  return {records:new Map(),sequences:new Map(),tails:new Map(),events:new EventEmitter()};
}

export function createGameSessionStore({redis=null,backend=createInMemoryGameSessionBackend(),instanceId,ttlMs=GAME_SESSION_TTL_MS,required=false}={}){
  const callbacks=new Set();
  const lockContext=new AsyncLocalStorage();
  const backendListener=message=>{
    for(const fn of callbacks)fn(message);
  };
  backend.events?.on(GAME_SESSION_CHANNEL,backendListener);
  if(redis?.duplicate){
    const subscriber=redis.duplicate();
    subscriber.on('message',(channel,message)=>{if(channel===GAME_SESSION_CHANNEL)for(const fn of callbacks)fn(message);});
    void subscriber.subscribe(GAME_SESSION_CHANNEL);
    backend.subscriber=subscriber;
  }
  const accountKey=s=>`${Number(s.agentId)}:${Number(s.userId)}`;
  const keys=s=>['gogame:game-session:'+accountKey(s),'gogame:game-session-generation:'+accountKey(s)];
  async function withAccountLock(session,action){
    const key=accountKey(session),active=lockContext.getStore();
    if(active===key)return action();
    if(required&&!redis)throw Object.assign(new Error('Game session Redis unavailable'),{code:'SESSION_STORE_UNAVAILABLE'});
    if(redis){
      if(!redis.set||!redis.eval)throw Object.assign(new Error('Game session lock storage unavailable'),{code:'SESSION_LOCK_UNAVAILABLE'});
      const lockKey='gogame:game-session-operation:'+key,token=randomUUID(),deadline=Date.now()+10000;
      while(await redis.set(lockKey,token,'PX',GAME_SESSION_OPERATION_TTL_MS,'NX')!=='OK'){
        if(Date.now()>=deadline)throw Object.assign(new Error('Game session operation lock timed out'),{code:'SESSION_LOCK_TIMEOUT'});
        await new Promise(resolve=>setTimeout(resolve,10+Math.floor(Math.random()*15)));
      }
      let stopped=false;
      const renew=setInterval(()=>{if(!stopped)void redis.eval(RENEW_LOCK_SCRIPT,1,lockKey,token,GAME_SESSION_OPERATION_TTL_MS).catch(()=>{});},10000);
      renew.unref?.();
      try{return await lockContext.run(key,action);}
      finally{stopped=true;clearInterval(renew);await redis.eval(UNLOCK_SCRIPT,1,lockKey,token);}
    }
    const previous=backend.tails.get(key)||Promise.resolve();
    let release;
    const turn=new Promise(resolve=>{release=resolve;});
    const tail=previous.catch(()=>{}).then(()=>turn);
    backend.tails.set(key,tail);
    await previous.catch(()=>{});
    try{return await lockContext.run(key,action);}
    finally{release();if(backend.tails.get(key)===tail)backend.tails.delete(key);}
  }
  function publish(message){
    if(redis?.publish)void redis.publish(GAME_SESSION_CHANNEL,JSON.stringify(message));
    else backend.events?.emit(GAME_SESSION_CHANNEL,JSON.stringify(message));
  }
  async function apply(action,session,extra={}){
    if(!Number.isSafeInteger(Number(session.agentId))||Number(session.agentId)<0||!Number.isSafeInteger(Number(session.userId))||Number(session.userId)<=0)
      throw new Error('Invalid game session identity');
    if(required&&!redis)throw Object.assign(new Error('Game session Redis unavailable'),{code:'SESSION_STORE_UNAVAILABLE'});
    const input={instanceId,socketId:session.socketId,loginId:session.loginId,...extra};
    if(redis?.eval){
      const [recordKey,generationKey]=keys(session);
      const attemptKey='gogame:game-session-attempt:'+Number(session.userId);
      const result=await redis.eval(GAME_SESSION_SCRIPT,3,recordKey,generationKey,attemptKey,action,JSON.stringify(input),ttlMs,GAME_SESSION_CHANNEL);
      return typeof result==='string'?JSON.parse(result):result;
    }
    const key=accountKey(session),old=backend.records.get(key);
    if(action==='claim'){
      if(Number(extra.attempt||0)<(backend.sequences.get('attempt:'+Number(session.userId))||0))return{ok:false,stale:true};
      if(extra.allowPair&&old?.primary?.inRoom&&old.primary.identity===extra.identity&&old.primary.roomId===extra.roomId
        &&old.primary.gameId===extra.gameId&&[19,24,25,26,31].includes(old.primary.roomType)&&old.paired.length===0){
        old.paired.push({...input,role:'hundred'});old.expiresAt=Date.now()+ttlMs;return{ok:true,loginId:old.loginId,generation:old.generation,role:'hundred'};
      }
      const generation=(backend.sequences.get(key)||0)+1;backend.sequences.set(key,generation);
      if(old)publish({event:'revoke',loginId:old.loginId,reason:'replaced'});
      const primary={...input,generation,role:'primary'};
      backend.records.set(key,{loginId:input.loginId,generation,primary,paired:[],expiresAt:Date.now()+ttlMs});
      return{ok:true,loginId:input.loginId,generation,role:'primary',revokedLoginId:old?.loginId||''};
    }
    if(!old||old.expiresAt<=Date.now())return action==='verify'||action==='renew'||action==='release'||action==='update'?false:null;
    const owns=old.loginId===session.loginId&&(old.primary?.socketId===session.socketId||old.paired.some(p=>p.socketId===session.socketId));
    if(action==='verify')return owns;
    if(action==='renew'){if(owns)old.expiresAt=Date.now()+ttlMs;return owns;}
    if(action==='update'){
      if(!old.primary||old.primary.socketId!==session.socketId||old.loginId!==session.loginId)return false;
      Object.assign(old.primary,{inRoom:extra.inRoom,roomId:extra.roomId,gameId:extra.gameId,roomType:extra.roomType});old.expiresAt=Date.now()+ttlMs;return true;
    }
    if(action==='release'){
      if(!owns)return false;
      if(old.primary.socketId===session.socketId){backend.records.delete(key);if(old.paired.length)publish({event:'revoke',loginId:old.loginId,reason:'primary-closed'});}
      else{old.paired=old.paired.filter(p=>p.socketId!==session.socketId);if(old.paired.length)old.expiresAt=Date.now()+ttlMs;else backend.records.delete(key);}
      return true;
    }
    throw new Error('Invalid game session action');
  }
  return{
    instanceId,ttlMs,
    subscribe(fn){callbacks.add(fn);return()=>callbacks.delete(fn);},
    async beginAttempt(userId){
      const uid=Number(userId);if(!Number.isSafeInteger(uid)||uid<=0)throw new Error('Invalid game session attempt user');
      if(required&&!redis)throw Object.assign(new Error('Game session Redis unavailable'),{code:'SESSION_STORE_UNAVAILABLE'});
      if(redis?.incr)return Number(await redis.incr('gogame:game-session-attempt:'+uid));
      const key='attempt:'+uid,next=(backend.sequences.get(key)||0)+1;backend.sequences.set(key,next);return next;
    },
    async claim(session,{identity,allowPair=false,attempt=0}={}){return withAccountLock(session,()=>apply('claim',session,{identity,allowPair,attempt,roomId:Number(session.roomId),gameId:String(session.gameId||''),roomType:Number(session.roomType)||0}));},
    verify:session=>apply('verify',session),renew:session=>apply('renew',session),
    async withSession(session,action){return withAccountLock(session,async()=>{
      if(!await apply('verify',session))return false;
      return action();
    });},
    serialize(session,action){return withAccountLock(session,action);},
    updateRoom(session,table){return withAccountLock(session,()=>apply('update',session,{inRoom:Boolean(session.inRoom),roomId:Number(session.roomId)||0,
      gameId:String(session.gameId||''),roomType:Number(table?.roomType)||0}));},
    release(session){return withAccountLock(session,()=>apply('release',session));},
    async close(){if(backend.subscriber)await backend.subscriber.disconnect();backend.events?.off(GAME_SESSION_CHANNEL,backendListener);callbacks.clear();},
  };
}
