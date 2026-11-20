import {rel} from '../rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {queryHistory}=await rel(import.meta.url,'../../../shared/history-query.js',version);
const {nativeHistorySnapshot}=await rel(import.meta.url,'../../../shared/native-history-snapshot.js',version);
const {blackjackPlayerActions,seatChoiceActions,arrangementChoiceActions,mahjongDiscardActions}=await rel(import.meta.url,'../../../shared/native-player-actions.js',version);
const clone=value=>value==null?value:structuredClone(value);
const names={19:'dzpk',24:'qznn',25:'ctjh',26:'jsmj',27:'sss',28:'csmj',30:'hzxl',31:'bj21',32:'sgya'};

// Called only while the real completed hand still exists. The input player
// rows are already masked for this owner; never read another player's holes.
export function captureNativeHistory(table,hand,results,players,uid,publicResult){
  if(!hand||!names[table.roomType]||[19,101].includes(Number(table.roomType)))return null;
  const inning=table.currentInning,time=Date.now(),room=table.roomId;
  const profiles=new Map(players.map(p=>[Number(p.uid),p]));
  const events=(hand.events||[]).map(event=>{
    const {cards,hole,handCards,...safe}=clone(event),p=profiles.get(Number(event.uid));
    return {...safe,nickName:String(p?.userName||p?.userInfo?.name||event.uid||''),name:String(p?.userName||event.uid||''),icon:p?.userIcon};
  });
  const rows=players.map(p=>({...clone(p),openingPoint:(hand.players||hand.participants||[]).find(m=>Number(m.uid)===Number(p.uid))?.openingPoint??p.openingPoint??0}));
  const row={gameRoomId:room,currentInningNum:inning,innerEndTime:time,endTime:time,firstGameList:rows,
    secondGameList:[],currentInningJoin:true,pot:hand.pot||0,insurance:0,collect:false,excellentGame:false,
    reportMsg:{reportFree:0,bigBlind:0,innerReport:false,playerList:[]}};
  if(Number(table.roomType)===25)row.excellentGame=events.some(e=>e.operationType===6);
  if([25,32].includes(Number(table.roomType)))for(const p of rows){
    p.posName=p.posName??String(Number(p.pos)+1);p.posType=Number(p.pos)+1;p.cardTypePokers=clone(p.handPais||[]);
    p.operateList=[{operate:0,gameState:3,cards:clone(p.handPais||[]),bet:0},...events.filter(e=>Number(e.uid)===Number(p.uid)).map(e=>({...e,operate:e.operationType}))];
  }
  if(Number(table.roomType)===27){row.compareResult=clone(hand.comparison);row.horseCardPosition=26;}
  if([24,27].includes(Number(table.roomType)))row.playMode=table.playMode;
  if(Number(table.roomType)===24)row.seeCardNo=(hand.rules||table.roomRules)?.seeCardNo;
  if(Number(table.roomType)===24)for(const p of rows){
    p.seeCardNo=row.seeCardNo;p.posType=p.banker?1:0;p.cardTypePokers=clone(p.handPais||[]);
    p.handCardListWithLaiZi=table.playMode===7?clone(p.handCardListWithLaiZi||[]):[];
  }
  if([26,28,30].includes(Number(table.roomType))){
    if(!publicResult?.resultList)return null;
    Object.assign(row,clone(publicResult),{bankerPos:hand.bankerPos,roundList:events});
    row.playerList=publicResult.resultList.map(p=>({...clone(p),userInfo:profiles.get(Number(p.uid))?.userInfo,userName:p.name,
      userIcon:profiles.get(Number(p.uid))?.userIcon,handPais:clone(p.handCards||[]),paiList:clone(p.handCards||[]),
      isBanker:p.pos===hand.bankerPos,isWinner:p.uid===publicResult.winUid}));
    row.flowerFan=Object.fromEntries(publicResult.resultList.map(p=>[p.uid,p.flowerFan]));
    row.gangFan=Object.fromEntries(publicResult.resultList.map(p=>[p.uid,p.gangFan]));
  }
  if(Number(table.roomType)===31){
    const dealer=hand.actionList?.filter(a=>a.banker).at(-1);
    if(!dealer?.handResults)return null;
    row.firstGameList=rows.filter(p=>!p.banker).map(p=>({...p,name:p.userName,icon:p.userIcon,banker:false,
      displaySeat:table.playMode?([1,2,3,5,6][p.pos]??'未记录'):p.pos,insuranceBet:p.insuranceAmount,handResults:clone(p.handResults||[])}));
    row.firstGameList.unshift({uid:0,name:'',icon:'15',banker:true,score:0,insuranceBet:0,insuranceProfit:0,handResults:clone(dealer.handResults)});
    if(table.playMode)row.bankerSettles=Object.fromEntries([[1,'normal'],[2,'special']].map(([type,key])=>[key,{bankers:(hand.bankers||[]).filter(b=>b.bankerType===type).map(b=>({uid:b.uid,name:b.entry.name,icon:b.entry.icon,proportion:b.entry.proportion,score:b.score}))}]));
  }
  const config={roomType:names[table.roomType],playMode:table.playMode,[names[table.roomType]+'Params']:clone(hand.rules||table.roomRules||{})};
  // Keep one settled detail snapshot. HTTP/WS envelopes are formed at read
  // time rather than persisting a second serialized copy of every player row.
  return {row,config,events,ante:table.ante,forceShowCard:table.forceShowCard,
    ...(Number(table.roomType)===31?{blackjackBehavior:{version:1,playerId:uid,...blackjackPlayerActions(hand.actionList,uid)}}:{}),
    ...([24,32].includes(Number(table.roomType))?{seatChoiceBehavior:{version:1,playerId:uid,...seatChoiceActions(table.roomType,hand,uid)}}:{}),
    ...(Number(table.roomType)===27?{arrangementBehavior:{version:1,playerId:uid,...arrangementChoiceActions(hand,uid)}}:{}),
    ...([26,28,30].includes(Number(table.roomType))?{mahjongBehavior:{version:1,playerId:uid,...mahjongDiscardActions(hand,uid)}}:{})};
}

export async function gameHistoryRecords(ctx,body={}){
  const {table,session,runtime}=ctx;
  if(!session||Number(session.agentId)!==Number(table.agentId))throw Object.assign(new Error('回顾账户与房间不匹配'),{status:403});
  const room=Number(body.roomId??body.gameRoomId??table.roomId);
  if(room!==Number(table.roomId))throw Object.assign(new Error('不能查看其他房间回顾'),{status:403});
  for(const key of ['inningNum','beginNum','endNum'])if(body[key]!=null&&(!Number.isSafeInteger(Number(body[key]))||Number(body[key])<(key==='inningNum'?1:-1)))
    throw Object.assign(new Error('无效回顾范围'),{status:400});
  if(Number(body.beginNum)>=0&&Number(body.endNum)>=0&&Number(body.beginNum)>Number(body.endNum))throw Object.assign(new Error('回顾范围倒置'),{status:400});
  const endTime=Date.now(),startTime=Math.max(1,Number(table.createdAt)||endTime-31*86400000);
  const query={userId:Number(session.userId),agentId:Number(session.agentId),currency:session.currency||'CNY',kind:'hands',
    roomType:Number(table.roomType),roomId:room,page:1,size:100,startTime,endTime,sortDesc:true};
  // Excellent history is filtered by facts inside each original log. Request
  // this owner's full bounded room result rather than just the newest 100;
  // kind=room uses the same cash settlement reader and its byte/time budgets.
  const excellent=Number(table.roomType)===25&&body.excellentGame===true;
  if(excellent)query.kind='room';
  const options=table.createdAt?{rollingEnd:true}:{relativeWindowMs:31*86400000};
  let result=await queryHistory(runtime,query,options);
  if(!Array.isArray(result?.records))throw Object.assign(new Error('正式回顾数据无效'),{status:503});
  const authorized=rows=>rows.filter(r=>Number(r.userId)===Number(session.userId)&&Number(r.agentId)===Number(session.agentId)&&r.currency===(session.currency||'CNY')
    &&Number(r.roomId)===room&&Number(r.roomType)===Number(table.roomType)).sort((a,b)=>a.inning-b.inning);
  const latest=authorized(result.records),totalInning=latest.at(-1)?.inning||0;
  const requested=body.inningNum!=null?Number(body.inningNum):Number(body.beginNum)>=0?Number(body.beginNum)+1:0;
  const excellentAll=excellent&&Number(body.beginNum)===0&&Number(body.endNum)===0&&body.inningNum==null;
  const needsExact=body.inningNum!=null&&!latest.some(row=>Number(row.inning)===requested);
  const rangeSpecified=Number(body.beginNum)>=0||Number(body.endNum)>=0;
  const needsRange=body.inningNum==null&&rangeSpecified&&(!latest.length||(requested>0&&requested<latest[0].inning)
    ||(Number(body.endNum)>=0&&Number(body.endNum)+1<latest[0].inning));
  if(!excellentAll&&(needsExact||needsRange)){
    result=await queryHistory(runtime,{...query,...(body.inningNum!=null?{inning:requested}:{inningFrom:requested,...(Number(body.endNum)>=0?{inningTo:Number(body.endNum)+1}:{}),
      ...(Number(table.roomType)===25?{sortDesc:false,size:20}:{})})},options);
    if(!Array.isArray(result?.records))throw Object.assign(new Error('正式回顾数据无效'),{status:503});
  }
  const records=authorized(result.records);records.totalInning=Math.max(totalInning,records.at(-1)?.inning||0);return records;
}

export async function queryNativeHistory(ctx,body={}){
  const {table}=ctx,records=await gameHistoryRecords(ctx,body);
  const inning=body.inningNum!=null?Number(body.inningNum):Number(body.beginNum)>=0?Number(body.beginNum)+1:0;
  const select=r=>!inning||Number(r.inning)===inning;
  const snapshots=new Map(records.map(record=>[record,nativeHistorySnapshot(record)]));
  const available=records.filter(r=>snapshots.get(r)?.row&&(!body.excellentGame||Number(table.roomType)!==25||snapshots.get(r).row.excellentGame));
  const begin=Number(body.beginNum),end=Number(body.endNum),explicit=Number(body.inningNum)>0;
  const allExcellent=Number(table.roomType)===25&&body.excellentGame===true&&begin===0&&end===0&&!explicit;
  let selected=explicit?available.filter(r=>r.inning===Number(body.inningNum)):allExcellent?available:available.filter(r=>(!(begin>=0)||r.inning>=begin+1)&&(!(end>=0)||r.inning<=end+1));
  if((!(begin>=0)&&!(end>=0)&&!explicit)||allExcellent)selected=selected.slice(Number(table.roomType)===25?-20:-1);
  else selected=Number(table.roomType)===25?selected.slice(0,20):selected.slice(-20);
  const single=[24,27,31].includes(Number(table.roomType));
  const latest=(single?available.filter(select):selected).at(-1),native=latest&&snapshots.get(latest);
  const total=records.totalInning||records.at(-1)?.inning||0;
  const ante=native?.ante??latest?.room?.ante??(latest?undefined:table.ante);
  const playMode=latest?.playMode??table.playMode??0;
  const seeCardNo=native?.row.seeCardNo??latest?.room?.seeCardNo??(latest?undefined:table.roomRules?.seeCardNo);
  const base={gameRoomId:table.roomId,roomTypeName:names[table.roomType],ante,blind:JSON.stringify({ante,diFen:ante,seeCardNo}),totalNum:total,isOfflineData:false};
  if(Number(table.roomType)===24)return {...base,seeCardNo,dataInfo:native?clone(native.row):{currentInningNum:inning,firstGameList:[]}};
  if(Number(table.roomType)===27)return {...base,dataInfo:native?clone(native.row):null};
  if(Number(table.roomType)===31)return {currentInning:latest?.inning||0,total,gameBackInfo:{gameRoomId:table.roomId,gameId:table.roomId,roomTypeName:'bj21',ante,playMode,
    inningInfo:[clone(native?.row.firstGameList||[])],...(native?.row.bankerSettles?{bankerSettles:[clone(native.row.bankerSettles)]}:{})}};
  return {...base,diFen:ante,excellentGame:Boolean(body.excellentGame),beginNum:selected[0]?.inning||0,endNum:selected.at(-1)?.inning||0,playBackList:selected.map(r=>clone(snapshots.get(r).row))};
}

export async function queryHundredHistory(ctx,inning){
  if(inning!=null&&(!Number.isSafeInteger(inning)||inning<=0))return null;
  const records=await gameHistoryRecords(ctx,inning==null?{}:{inningNum:inning}),table=ctx.table;
  if(inning==null)return {gameRoomId:table.roomId,list:records.map(r=>r.inning)};
  const row=records.find(r=>r.inning===inning);if(!row)return null;
  const detail=clone(row.detail);
  // Existing finance logs may contain public result fields directly in detail.
  return {...detail,gameRoomId:table.roomId,currInning:inning,winAreaIds:detail.winAreaIds||detail.winningAreas||[],betDetailTableMap:detail.betDetailTableMap||{}};
}
