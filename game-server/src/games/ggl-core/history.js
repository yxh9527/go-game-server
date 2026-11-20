import {createHash} from 'node:crypto';
import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { prizeFromMask } = await rel(import.meta.url, './rules.js', v);
const TTL_SECONDS=180,WINDOW_MS=31*86400000;
function parse(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
function decodeRecord(row,table,account){
  if(Number(row?.userId)!==account.userId||Number(row?.agentId)!==account.agentId||row?.currency!==account.currency)return null;
  const record=parse(row.log);
  if(Number(record?.roomType)!==table.roomType||Number(record?.roomId)!==table.roomId||Number(record?.gameRoomId)!==table.gameRoomId)return null;
  if(!record||typeof record.serialNo!=='string'||!record.serialNo||!Number.isSafeInteger(record.faceValue)
    ||!table.config.denominations.includes(record.faceValue))return null;
  try {
    const prize = prizeFromMask(record.huMask, table.config.winMultipliers);
    if (prize.huCount !== record.huCount || prize.multiplier !== record.multiplier || record.amount !== record.faceValue * (prize.multiplier - 1)) return null;
    return { serialNo: record.serialNo, faceValue: record.faceValue, huMask: record.huMask.slice(), ...prize,
      roomType: table.roomType, amount: record.amount };
  } catch { return null; }
}
export async function list(ctx) {
  const {table,session,runtime}=ctx;
  const account={agentId:Number(session.agentId),userId:Number(session.userId),currency:String(session.currency||'')};
  if(!Number.isSafeInteger(account.agentId)||account.agentId<0||account.agentId!==Number(table.agentId)
    ||!Number.isSafeInteger(account.userId)||account.userId<=0||!account.currency
    ||![61,63].includes(Number(table.roomType))||!Number.isSafeInteger(table.roomId)||table.roomId<=0)
    throw new Error('Invalid trusted scratch history scope');
  // Native 6121 has no paging/time filters. Canonical server-owned parameters
  // give repeated requests one key; raw client objects never reach this key.
  const gameId=Number(ctx.financialGameId??table.cfg?.finance_game_id??table.roomType);
  const normalized={...account,gameId,roomType:table.roomType,roomId:table.roomId,
    gameRoomId:table.gameRoomId,page:1,size:100,windowMs:WINDOW_MS,sortDesc:true};
  const key='scratch-history:v3:'+createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  const state=runtime.scratchHistoryReads||={pending:new Map()};
  if(state.pending.has(key))return state.pending.get(key);
  const bus=runtime.rpc?.bus,gateway=runtime.rpc?.gateway||runtime.gateway;
  const task=(async()=>{
    let cached;
    try{cached=parse(await bus?.getCache(key));}catch{ /* Read ES if cache is unavailable. */ }
    if(cached?.gameRoomId===table.gameRoomId&&Array.isArray(cached.winInfo))return cached;
    if(!gateway?.getScratchHistory)throw new Error('Scratch settlement history service unavailable');
    const endTime=Date.now();
    const response=await gateway.getScratchHistory({...account,gameId,roomType:table.roomType,roomId:table.roomId,gameRoomId:table.gameRoomId,
      size:100,startTime:endTime-WINDOW_MS,endTime});
    if(!Array.isArray(response?.records))throw new Error('Invalid scratch ES history response');
    const seen=new Set(),winInfo=[];
    for(const row of response.records){
      const data=Number(row?.gameId)===gameId?decodeRecord(row,table,account):null;
      if(data&&!seen.has(data.serialNo)){seen.add(data.serialNo);winInfo.push(data);}
      if(winInfo.length===100)break;
    }
    const result={gameRoomId:table.gameRoomId,winInfo:winInfo.reverse()};
    try{await bus?.setCache(key,JSON.stringify(result),TTL_SECONDS);}catch{ /* ES remains authoritative. */ }
    return result;
  })();
  state.pending.set(key,task);
  try{return await task;}finally{if(state.pending.get(key)===task)state.pending.delete(key);}
}
