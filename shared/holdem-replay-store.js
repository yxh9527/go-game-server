import {formatHoldemReplayList,formatHoldemReplayDetail} from './holdem-replay-format.js';
import {queryHistory} from './history-query.js';

const fail=(status,message)=>Object.assign(new Error(message),{status,code:status});
const validId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0;

// Capture each real participant's own view. Never persist an opponent's hidden
// holes in that participant's record, including cards embedded in action events.
export function captureHoldemReplay(table,hand,results,viewerId){
  if(!hand||!Array.isArray(hand.board))return null;
  const firstGameList=(hand.participants||hand.statsPlayers||table.members).filter(m=>m.hole?.length).map(m=>{
    const result=results.find(r=>Number(r.uid)===Number(m.uid))||{},own=Number(m.uid)===Number(viewerId);
    const holes=own?m.hole.slice(0,2):result.showCards?.length?result.showCards.slice(0,2):[-1,-1];
    return {uid:m.uid,userName:m.name,userIcon:m.icon,pos:m.pos,posName:m.posName,openingPoint:m.openingPoint||0,
      score:result.score||0,isWin:Boolean(result.isWin),cardTypeId:result.cardTypeId||0,cardTypeInfo:result.cardTypeInfo,
      showCards:holes,handPais:holes,cards:[...holes,...hand.board],commonPoker:hand.board.slice(),
      operateList:(hand.replayActions||[]).filter(a=>a.uid===m.uid).map(({cards,...action})=>({...action}))};
  });
  return {innerEndTime:Date.now(),gameRoomId:table.roomId,currentInningNum:table.currentInning,
    smallBlind:table.smallBlind,bigBlind:table.bigBlind,initialBet:hand.initialBet??table.initialBet??table.bigBlind,
    playMode:hand.playMode??0,pot:hand.pot,forceShowCard:false,firstGameList,secondGameList:[],
    roundEvents:(hand.replayEvents||[]).map(({cards,board,...event})=>({...event,
      ...(Array.isArray(board)?{board:board.slice(0,5)}:Array.isArray(cards)?{board:cards.slice(2,7)}:{})}))};
}

export async function queryHoldemReplay(runtime,account,request={},detail=false){
  const roomId=Number(request.roomId??request.gameRoomId),inning=Number(request.inningNum||0);
  if(!validId(account.userId)||!validId(account.agentId)||!validId(roomId)||detail&&!validId(inning))throw fail(400,'无效回顾身份、房号或局号');
  const gateway=runtime.gateway||runtime.rpc?.gateway;
  if(typeof gateway?.getUserCenter!=='function')throw fail(503,'正式回顾存储接口未配置');
  const endTime=Math.ceil(Date.now()/30000)*30000;
  const from=request.beginNum==null?-1:Number(request.beginNum),to=request.endNum==null?-1:Number(request.endNum);
  if(!detail&&([from,to].some(n=>!Number.isFinite(n)||!Number.isSafeInteger(n)||n < -1)||from>=0&&to>=0&&from>to))throw fail(400,'回顾范围无效');
  const excellent=Boolean(request.excellentGame),excellentAll=!detail&&excellent&&from===0&&to===0;
  const roomType=Number(request.roomType)||(detail?0:19);if(![0,19,101].includes(roomType))throw fail(400,'无效德州回放类型');
  const query={kind:'replay',userId:Number(account.userId),agentId:Number(account.agentId),currency:account.currency||'CNY',
    roomType,roomId,page:1,size:100,startTime:Math.max(1,Number(request.roomCreatedAt)||endTime-31*86400000),endTime,sortDesc:true,
    ...(detail?{inning}:excellent?{allInnings:true}:{})};
  const key='holdem-replay:v3:'+JSON.stringify({...query,endTime:0,...(!detail?{beginNum:from,endNum:to,excellentGame:excellent}:{})}),state=runtime.holdemReplayReads||={pending:new Map()};
  if(state.pending.has(key))return state.pending.get(key);
  if(state.pending.size>=256)throw fail(503,'回顾查询繁忙，请稍后重试');
  const task=(async()=>{
    const options=request.roomCreatedAt?{rollingEnd:true}:{relativeWindowMs:31*86400000};
    let source=await queryHistory(runtime,query,options);
    if(!Array.isArray(source?.records))throw fail(503,'正式回顾数据无效');
    const authorized=rows=>rows.filter(r=>Number(r.userId)===query.userId&&Number(r.agentId)===query.agentId&&r.currency===query.currency&&Number(r.roomId)===roomId
      &&(roomType?Number(r.roomType)===roomType:[19,101].includes(Number(r.roomType)))&&r.detail?.replay
      &&Number(r.detail.replay.gameRoomId)===roomId&&Number(r.detail.replay.currentInningNum)===Number(r.inning)&&(!detail||Number(r.inning)===inning))
      .sort((a,b)=>Number(a.inning)-Number(b.inning));
    let records=authorized(source.records);
    const totalInning=records.at(-1)?.inning||0;
    if(!detail&&!excellentAll&&!excellent&&(from>=0||to>=0)&&(!records.length||from>=0&&from+1<Number(records[0].inning)||to>=0&&to+1<Number(records[0].inning))){
      source=await queryHistory(runtime,{...query,inningFrom:from>=0?from+1:0,inningTo:to>=0?to+1:0,size:20,sortDesc:false},options);
      if(!Array.isArray(source?.records))throw fail(503,'正式回顾数据无效');
      records=authorized(source.records);
    }
    const latest=records.at(-1),replay=latest?.detail.replay,table={roomId,smallBlind:replay?.smallBlind??latest?.room?.smallBlind??0,bigBlind:replay?.bigBlind??latest?.room?.bigBlind??0,
      initialBet:replay?.initialBet??latest?.room?.initialBet??0,playMode:latest?.playMode||0,history:records.map(r=>r.detail.replay),
      ...(!excellent?{historyTotalInning:Math.max(Number(totalInning),Number(latest?.inning)||0)}:{})};
    if(detail)return formatHoldemReplayDetail(table,inning);
    return formatHoldemReplayList(table,{...request,roomId,beginNum:from,endNum:to});
  })();state.pending.set(key,task);
  try{return await task}finally{state.pending.delete(key)}
}
