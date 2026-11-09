const DAY=86400000,OFFSET=8*3600000;
const raises=new Set([3,4,5,8,9,12,13,14,15]);
const isRaise=a=>Number(a.operate??a.operationType)===9?a.isRaise===true:raises.has(Number(a.operate??a.operationType));
export const parseList=value=>{if(Array.isArray(value))return value;if(typeof value==='string'){try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed:[];}catch{}}return [];};
export function playerPanelWindows(now=Date.now()){
  const today=Math.floor((now+OFFSET)/DAY)*DAY-OFFSET,weekday=new Date(today+OFFSET).getUTCDay();
  return {today,week:today-((weekday+6)%7)*DAY,sevenDays:today-6*DAY,now};
}
const percent=(n,total)=>total?Math.round(n/total*10000)/100:0;
const actionsFor=(record,uid)=>parseList(record.players).find(p=>Number(p.uid)===Number(uid))?.operateList;
function rates(records,uid){
  let voluntary=0,raised=0,known=0;
  for(const record of records){
    const actions=actionsFor(record,uid);if(!Array.isArray(actions)||actions.some(a=>Number(a.operate??a.operationType)===9&&typeof a.isRaise!=='boolean'))continue;known++;
    const pre=actions.filter(a=>Number(a.gameState)===4),paid=pre.filter(a=>Number(a.bet??a.currentBetScore)>0);
    if(paid.some(a=>Number(a.operate??a.operationType)===7||raises.has(Number(a.operate??a.operationType))))voluntary++;
    if(paid.some(isRaise))raised++;
  }
  return {voluntary:known===records.length?percent(voluntary,known):'--',raised:known===records.length?percent(raised,known):'--'};
}
function betRates(records,uid){
  let three=0,threeChance=0,four=0,fourChance=0,postThree=0,postChance=0,complete=true;
  for(const record of records){
    if(!Array.isArray(record.events)){complete=false;continue;}
    const seen=new Set();let count=0;
    for(const action of record.events.filter(a=>Number(a.gameState)===4)){
      const op=Number(action.operate??action.operationType),raise=isRaise(action)&&Number(action.bet??action.currentBetScore)>0;
      if(op===9&&typeof action.isRaise!=='boolean')complete=false;
      if(Number(action.uid)===Number(uid)&&[1,2].includes(count)&&!seen.has(count)){
        seen.add(count);if(count===1){threeChance++;if(raise)three++;}else{fourChance++;if(raise)four++;}
      }
      if(raise)count++;
    }
    for(const state of [6,8,10]){
      let aggressive=0,seenChance=false;
      for(const action of record.events.filter(a=>Number(a.gameState)===state)){
        const op=Number(action.operate??action.operationType),raise=isRaise(action)&&Number(action.bet??action.currentBetScore)>0;
        if(op===9&&typeof action.isRaise!=='boolean')complete=false;
        if(Number(action.uid)===Number(uid)&&aggressive===2&&!seenChance){postChance++;if(raise)postThree++;seenChance=true;}
        if(raise)aggressive++;
      }
    }
  }
  return {flip3BetRate:complete?percent(three,threeChance):'--',flip3BetNum:complete?three:'--',
    flip4BetRate:complete?percent(four,fourChance):'--',flip4BetNum:complete?four:'--',
    postFlop3BetRate:complete?percent(postThree,postChance):'--',postFlop3BetNum:complete?postThree:'--'};
}
export function playerPanelStatistics(records,{targetId,roomId,now=Date.now(),complete=true}={}){
  const windows=playerPanelWindows(now),own=records.filter(r=>Number(r.userId)===Number(targetId));
  const recent=own.filter(r=>r.endedAt>=windows.sevenDays&&r.endedAt<=now),basic=rates(own,targetId),table=rates(own.filter(r=>Number(r.roomId)===Number(roomId)),targetId);
  const peers=new Map();
  for(const record of recent)for(const player of parseList(record.players)){
    const uid=Number(player.uid);if(uid===Number(targetId)||!uid)continue;
    const data=peers.get(uid)||{uid,nickName:player.userName||player.name||player.userInfo?.name||String(uid),records:[]};
    data.records.push(record);peers.set(uid,data);
  }
  const tableMateRateList=[...peers.values()].map(p=>({uid:p.uid,nickName:p.nickName,rate:percent(p.records.length,recent.length),
    ...betRates(p.records,targetId)})).sort((a,b)=>b.rate-a.rate||a.uid-b.uid);
  const sum=rows=>rows.reduce((n,r)=>n+r.net,0);
  return {totalHands:complete?own.length:'--',flipManualBetPercent:complete?basic.raised:'--',joinPercent:complete?basic.voluntary:'--',
    tableJoinPercent:complete?table.voluntary:'--',todayScore:sum(recent.filter(r=>r.endedAt>=windows.today)),
    oneWeekScore:sum(recent.filter(r=>r.endedAt>=windows.week)),oneWeekHands:recent.length,
    tableMateRateList:complete?tableMateRateList:[],userFillingRate:complete?betRates(own,targetId):{flip3BetRate:'--',flip3BetNum:'--',flip4BetRate:'--',flip4BetNum:'--'}};
}

export function publicPlayerHand(record,viewerId){
  const roomType=Number(record.roomType)||19,holeCount=roomType===25?3:2;
  const players=parseList(record.players).map(p=>({uid:Number(p.uid),userName:p.userName||p.name||p.userInfo?.name||String(p.uid),
    userIcon:p.userIcon||p.icon||p.userInfo?.icon||'',score:p.score,isWin:Boolean(p.isWin),
    handPais:(Number(p.uid)===Number(viewerId)?p.handPais||p.showCards||[]:p.showCards||Array(holeCount).fill(-1)).slice(0,holeCount),
    showCards:(p.showCards||Array(holeCount).fill(-1)).slice(0,holeCount)}));
  const own=players.find(p=>p.uid===Number(record.userId)),winner=players.filter(p=>p.isWin||p.score>0).sort((a,b)=>b.score-a.score)[0];
  return {gameRoomId:record.roomId,currInning:record.inning,currentInningNum:record.inning,endTime:record.endedAt,innerEndTime:record.endedAt,
    roomType,playMode:record.playMode||0,ownScore:record.net,ownCards:own?.handPais||[],winCards:winner?.handPais||[],winScore:winner?.score||0,
    commonCards:(record.commonCards||[]).slice(0,5),winName:winner?.userName||'',firstGameList:players,effectiveBet:record.effectiveBet||0};
}

export function playerPanelPersistedRecords(records){
  return records.filter(r=>Number(r.roomType)===19&&Number(r.userId)>0&&Number(r.userId)<90000000).map(r=>{
    const players=parseList(r.detail?.firstGameList).map(p=>({uid:Number(p.uid),userName:p.userName||p.name||p.userInfo?.name||String(p.uid),
      userIcon:p.userIcon||p.icon||p.userInfo?.icon||'',score:Number(p.score)||0,isWin:Boolean(p.isWin),
      handPais:parseList(p.handPais).slice(0,2),showCards:parseList(p.showCards).slice(0,2),
      operateList:Array.isArray(p.operateList)?p.operateList.map(a=>({uid:Number(p.uid),gameState:Number(a.gameState),
        operate:Number(a.operate??a.operationType),bet:Number(a.bet??a.currentBetScore)||0,
        ...(typeof a.isRaise==='boolean'?{isRaise:a.isRaise}:{}),
        ...(Number.isInteger(a.replayOrder)?{replayOrder:a.replayOrder}:{})})):undefined}));
    const own=players.find(p=>p.uid===Number(r.userId)),pre=(own?.operateList||[]).filter(a=>a.gameState===4&&a.bet>0);
    const events=players.flatMap(p=>p.operateList||[]).filter(a=>Number.isInteger(a.replayOrder)).sort((a,b)=>a.replayOrder-b.replayOrder);
    return {id:r.id,agentId:r.agentId,userId:r.userId,currency:r.currency,roomId:r.roomId,inning:r.inning,endedAt:r.endedAt,
      net:r.net,effectiveBet:r.effectiveBet||0,playMode:r.playMode||0,players,commonCards:parseList(r.detail?.commonCards),
      events:events.length?events:undefined,countersKnown:Array.isArray(own?.operateList)&&!pre.some(a=>a.operate===9&&typeof a.isRaise!=='boolean'),
      raised:pre.some(isRaise),voluntary:pre.some(a=>a.operate===7||raises.has(a.operate))};
  });
}

export function projectPlayerNotes(payload,notes){
  if(!notes?.size||!payload||typeof payload!=='object')return payload;
  if(Array.isArray(payload))return payload.map(row=>projectPlayerNotes(row,notes));
  let result=payload;
  const note=notes.get(Number(payload.userInfo?.uid??payload.uid));
  if(note){
    result={...payload,remarkName:note.remarkName,remarkMessage:note.remarkMessage,mark:note.mark};
    if(payload.userInfo)result.userInfo={...payload.userInfo,...note};
    if(note.remarkName&&Object.hasOwn(payload,'userName'))result.userName=note.remarkName;
  }
  for(const field of ['memberList','OBmemberList','obMemberList','userList'])if(Array.isArray(payload[field])){
    if(result===payload)result={...payload};result[field]=payload[field].map(row=>projectPlayerNotes(row,notes));
  }
  return result;
}
