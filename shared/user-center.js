export const TABLE_ROOM_TYPES = new Set([19,20,21,24,25,26,27,28,30,31,32]);
const names={19:'dzpk',24:'qznn',25:'ctjh',26:'jsmj',27:'sss',28:'csmj',30:'hzxl',31:'bj21',32:'sgya'};
const score = value => {const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('Invalid user-center score');return n;};
const sum = (rows,key) => rows.reduce((total,row)=>score(total+score(row[key] ?? 0)),0);
function page(rows,query,paged=false){return paged?rows:rows.slice((query.page-1)*query.size,query.page*query.size);}
export function recordHandRow(record) {
  const detail=record.detail || {};
  const cards=[19,25].includes(Number(record.roomType))?holdemUserCenterDetail(detail.firstGameList || [],record.userId,detail.commonCards,Number(record.roomType)===25?3:2):{};
  return { ...cards,...detail,gameRoomId:record.roomId,currInning:record.inning,currentInningNum:record.inning,
    endTime:record.endedAt,innerEndTime:record.endedAt,ownScore:record.net,effectiveBet:record.effectiveBet,
    firstGameList:record.detail?.firstGameList || [],roomType:record.roomType,playMode:record.playMode || 0 };
}

// Input players have already been scoped to the requesting player's visibility.
export function holdemUserCenterDetail(players,userId,board,holeCount=2) {
  if(typeof players==='string'){try{players=JSON.parse(players);}catch{players=[];}}
  if(!Array.isArray(players))players=[];
  const own=players.find(p=>Number(p.uid)===Number(userId));
  const winner=players.filter(p=>p.isWin||p.score>0).sort((a,b)=>b.score-a.score)[0];
  const hole=p=>Number(p?.uid)===Number(userId)?p?.handPais:p?.showCards;
  return {ownCards:(hole(own)||[]).slice(0,holeCount),commonCards:(board||own?.commonPoker||[]).slice(0,5),
    winCards:(hole(winner)||[]).slice(0,holeCount),winScore:winner?.score ?? 0};
}
function roomSummary(records) {
  const latest=records.at(-1),first=records[0],aggregate=latest.aggregate || {},players=new Map();
  for(const record of records)for(const p of record.players || []){const old=players.get(Number(p.uid)) || {uid:Number(p.uid),score:0,takeIn:p.takeIn,userInfo:p.userInfo};old.score=score(old.score+score(p.score ?? 0));players.set(old.uid,old);}
  const total=aggregate.net ?? sum(records,'net'),hands=aggregate.totalHands ?? records.length,started=latest.room?.createdAt ?? aggregate.startedAt ?? first.endedAt;
  return { ...latest.room,id:latest.roomId,gameRoomId:latest.roomId,roomType:latest.roomType,playMode:latest.playMode || 0,
    createTime:started,endTime:latest.endedAt,currentScore:total,ownScore:total,
    totalHands:hands,totalInningNum:hands,manualBetNum:aggregate.manualBetNum ?? records.filter(r=>r.effectiveBet>0).length,
    walksNum:0,totalStream:aggregate.effectiveBet ?? sum(records,'effectiveBet'),
    totalTakeIn:latest.room?.totalTakeIn ?? latest.takeIn,gameTime:Math.floor(Math.max(0,latest.endedAt-started)/1000),
    roomResults:latest.room?.roomResults || [...players.values()],roomTypeName:names[latest.roomType] || String(latest.roomType),
    privateRoom:Boolean(latest.privateRoom),currentActivePoint:0 };
}

export function projectUserCenter(source,query) {
  let records=(source.records || []).filter(r=>Number(r.userId)===Number(query.userId)&&Number(r.agentId)===Number(query.agentId)
    &&(!r.currency||r.currency===query.currency)&&r.endedAt>=query.startTime&&r.endedAt<=query.endTime
    &&(!query.roomType||Number(r.roomType)===Number(query.roomType))&&(!query.roomId||Number(r.roomId)===Number(query.roomId))
    &&(!query.inning||Number(r.inning)===Number(query.inning))).sort((a,b)=>a.endedAt-b.endedAt||String(a.id).localeCompare(String(b.id)));
  if(query.kind==='funds'||query.kind==='tickets'){
    const logs=source.logs || (query.kind==='funds'?records.filter(r=>Number.isSafeInteger(r.balance)).map(r=>({
      id:r.id,createTime:r.endedAt,sourceType:2,sourceId:r.roomId,point:r.net,lastPoint:r.balance,roomType:r.roomType
    })):[]);
    const sorted=[...logs].sort((a,b)=>Number(b.createTime)-Number(a.createTime)||String(a.id).localeCompare(String(b.id)));
    return {count:source.total ?? sorted.length,pageNum:query.page,logs:page(sorted,query,source.paged)};
  }
  if(query.kind==='hands'){
    if(query.sortDesc)records.reverse();
    return {infoList:page(records,query,source.paged).map(recordHandRow),totalInning:source.total ?? records.length,
      ownJoinInning:source.total ?? records.length,ownScore:source.totalScore ?? sum(records,'net'),
      roomTypeName:names[records[0]?.roomType] || '',blind:JSON.stringify(records[0]?.room || {})};
  }
  if(query.kind==='round')return records.length?recordHandRow(records[0]):null;
  if(query.kind==='match')return source.match || null;
  if(query.kind==='room')return records.length?roomSummary(records):null;
  if(query.kind==='matches')return {mttExploitsMsgs:source.matches || [],totalScore:source.totalScore || 0};
  let infoList;
  if(TABLE_ROOM_TYPES.has(Number(query.roomType))){
    const groups=new Map();for(const record of records){const key=Number(record.roomId);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
    infoList=[...groups.values()].map(roomSummary).sort((a,b)=>b.endTime-a.endTime||b.gameRoomId-a.gameRoomId);
  }else infoList=records.slice().reverse().map(recordHandRow);
  return {infoList:page(infoList,query,source.paged),totalSize:source.total ?? infoList.length,totalScore:source.totalScore ?? sum(records,'net'),
    ownScore:source.totalScore ?? sum(records,'net'),pageNum:query.page,privateRoomOpen:false};
}
