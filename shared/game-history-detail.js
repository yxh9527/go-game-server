import {queryHistory} from './history-query.js';
import {queryHoldemReplay} from './holdem-replay-store.js';
import {nativeHistorySnapshot} from './native-history-snapshot.js';

export function nativeHistoryDetail(record){
  const native=nativeHistorySnapshot(record);
  if(!native?.row||native.finalOnly)return null;
  const rows=native.row.playerList||native.row.firstGameList||[];
  return {exploitsInfoMsgs:[{gameInningId:record.roomId+'_'+record.inning,
    gameRoomUnion:{gameRoomId:record.roomId,roomConfig:JSON.stringify(native.config||{})},inningResults:JSON.stringify(rows),
    inningInfo:JSON.stringify({ante:native.ante,forceShowCard:native.forceShowCard,userGameBackDetailMap:Object.fromEntries(rows.map(p=>[p.uid,p]))}),
    roundList:JSON.stringify(native.events||[]),memberResults:rows.filter(p=>Number(p.uid)>0).map(p=>({uid:p.uid,pos:p.pos,userInfo:p.userInfo,openingPoint:p.openingPoint,point:p.openingPoint,score:p.score}))}]};
}

export async function queryGameHistoryDetail(runtime,account,request={}){
  const roomId=Number(request.roomId??request.gameRoomId),inning=Number(request.inningNum),roomType=Number(request.roomType)||0;
  if(!Number.isSafeInteger(roomId)||roomId<=0||!Number.isSafeInteger(inning)||inning<=0||!Number.isSafeInteger(roomType)||roomType<0||roomType>10000)
    throw Object.assign(new Error('无效房间或牌局编号'),{status:400});
  if(roomType===101)return queryHoldemReplay(runtime,account,request,true);
  const endTime=Date.now(),source=await queryHistory(runtime,{...account,kind:'round',roomType,roomId,inning,page:1,size:1,
    startTime:endTime-31*86400000,endTime,sortDesc:true},{relativeWindowMs:31*86400000});
  const record=source.records?.find(r=>Number(r.userId)===Number(account.userId)&&Number(r.agentId)===Number(account.agentId)&&r.currency===account.currency
    &&Number(r.roomId)===roomId&&Number(r.inning)===inning&&(!roomType||Number(r.roomType)===roomType));
  if(record?.detail?.nativeHistory?.row)return nativeHistoryDetail(record);
  if(record?.roomType===19||!record&&!roomType)return queryHoldemReplay(runtime,account,request,true);
  return null;
}
