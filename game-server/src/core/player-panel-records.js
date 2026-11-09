import {rel} from '../rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {userInfoOf}=await rel(import.meta.url,'./member.js',version);
const {parseList,publicPlayerHand}=await rel(import.meta.url,'../../../shared/player-panel.js',version);
export const panelRoomNames={19:'dzpk',24:'qznn',25:'ctjh',26:'jsmj',27:'sss',28:'csmj',30:'hzxl',31:'bj21',32:'sgya'};
const playerFields=['uid','score','isWin','pos','banker','point','xiaZhuData','grabBankerPoint','raiseMultiple','multipleAnte',
  'cardTypeId','niuType','handCardListWithLaiZi','evalResult','handResults','insuranceBet','insuranceAmount','insuranceProfit',
  'handCards','groupCards','huCard','queType','winLoseStatus','finalHuInfo'];
const endFields=['winUid','last5Cards','fanjiangCards','addFanCard','winHuTypes','drawCardUid','drawCard','finalHuBranchMap'];
function pick(source,fields){return Object.fromEntries(fields.filter(key=>source?.[key]!==undefined).map(key=>[key,structuredClone(source[key])]));}

function snapshot(table,results,{inning=table.currentInning,endedAt=Date.now(),board=table.hand?.board,publicResult,profiles=[]}={}){
  const participants=table.hand?.statsPlayers||table.hand?.participants||table.hand?.players||[];
  const players=results.filter(p=>Number.isSafeInteger(Number(p.uid))&&Number(p.uid)>0&&Number.isSafeInteger(p.score)).map(p=>{
    const participant=participants.find(m=>Number(m.uid)===Number(p.uid));
    const member=participant?.member||participant||table.members?.find(m=>Number(m.uid)===Number(p.uid));
    const info=profiles.find(m=>Number(m.uid)===Number(p.uid))||p.userInfo||userInfoOf(member||p);
    const cards=parseList(p.showCards);
    return {...pick(p,playerFields),uid:Number(p.uid),userName:p.userName||info.name||p.name||String(p.uid),
      userIcon:p.userIcon||info.icon||p.icon||'',
      // Only the requesting owner may recover their private cards below.
      handPais:[19,25].includes(Number(table.roomType))?parseList(participant?.hole||member?.hole||p.cards||p.ownCards||p.handPais).slice(0,Number(table.roomType)===25?3:2)
        :parseList(p.handPais||p.handCards||p.cardList),
      showCards:[19,25].includes(Number(table.roomType))?(cards.length?cards:Array(Number(table.roomType)===25?3:2).fill(-1))
        :parseList(p.showCards||p.handPais||p.handCards||p.cardList)};
  });
  return {roomId:Number(table.roomId),roomType:Number(table.roomType),playMode:Number(table.playMode)||0,
    inning:Number(inning),endedAt:Number(endedAt)||0,players,commonCards:parseList(board).slice(0,5),
    end:pick(publicResult,endFields),
    dealerResults:Number(table.roomType)===31?structuredClone(table.hand?.actionList?.filter(p=>p.banker).at(-1)?.handResults||[]):[]};
}

// These are actual settled results, shared by all robots in this room. They
// belong to its lifetime and survive business reloads on the resident object.
// They never enter user-center persistence, funds, or synthetic profile data.
export function recordRoomPlayerHand(table,results,publicResult){
  if(table.mtt||!panelRoomNames[Number(table.roomType)]||!Number.isSafeInteger(table.currentInning)||table.currentInning<=0)return;
  const records=table.playerPanelHands ||= new Map();
  if(!records.has(table.currentInning))records.set(table.currentInning,snapshot(table,results,{publicResult}));
}

export function roomPlayerPanelRecords(table,targetId){
  const records=table.playerPanelHands ||= new Map();
  // Recover already-completed resident hands after hot update as well. Never
  // use the current hand or another room, and never invent missing timestamps.
  for(const row of [...(table.history||[]),...(table.mahjongHistory||[])]){
    const inning=Number(row.currentInningNum??row.inning);
    if(!Number.isSafeInteger(inning)||inning<=0||records.has(inning))continue;
    const results=parseList(row.firstGameList||row.players||row.result?.resultList);
    if(!results.length)continue;
    records.set(inning,snapshot({...table,hand:null,members:[]},results,{inning,
      endedAt:Number(row.innerEndTime??row.createdAt??row.time)||0,board:row.commonCards||results[0]?.commonPoker,
      publicResult:row.result,profiles:row.profiles}));
  }
  return [...records.values()].flatMap(record=>{
    const own=record.players.find(p=>p.uid===Number(targetId));
    return own?[{...record,userId:Number(targetId),net:own.score,effectiveBet:own.xiaZhuData||0}]:[];
  });
}

export function playerPanelHandRow(record,viewerId){
  const roomType=Number(record.roomType)||19;
  if([19,25].includes(roomType))return publicPlayerHand(record,viewerId);
  const players=parseList(record.players),detail=record.detail||{},end=record.end||{};
  const rows=players.map(p=>({...pick(p,playerFields),uid:Number(p.uid),name:p.userName||p.name||p.userInfo?.name||String(p.uid),
    icon:p.userIcon||p.icon||p.userInfo?.icon||'',userName:p.userName||p.name||p.userInfo?.name||String(p.uid),
    userIcon:p.userIcon||p.icon||p.userInfo?.icon||'',handPais:parseList(p.showCards||p.handPais||p.handCards),
    cardList:parseList(p.showCards||p.handPais||p.handCards),isBanker:Boolean(p.banker),niuType:p.niuType??p.cardTypeId}));
  const row={gameRoomId:record.roomId,currInning:record.inning,currentInningNum:record.inning,
    roomType,playMode:record.playMode||0,endTime:record.endedAt,innerEndTime:record.endedAt,ownScore:record.net,
    effectiveBet:record.effectiveBet||0,innerPlayerList:rows,firstGameList:JSON.stringify(rows)};
  if([26,28,30].includes(roomType)){
    // The final Mahjong settlement has already released these hands publicly.
    let stored={};try{stored=typeof detail.gameEndData==='string'?JSON.parse(detail.gameEndData):detail.gameEndData||{};}catch{}
    const result=rows.map(p=>({...p,handCards:parseList(p.handCards),groupCards:parseList(p.groupCards)}));
    const winner=result.filter(p=>p.score>0).sort((a,b)=>b.score-a.score)[0];
    const publicEnd={...pick(stored,endFields),...end};
    if(publicEnd.winUid===undefined)publicEnd.winUid=winner?.uid||0;
    publicEnd.finalHuBranchMap ||= Object.fromEntries(result.map(p=>[p.uid,{huOperateCode:p.finalHuInfo?.huOperateCode||0,huTypeList:p.finalHuInfo?.huTypeList||[]}]));
    row.gameEndData=JSON.stringify({...publicEnd,resultList:result,playerList:result});
  }
  if(roomType===31&&record.dealerResults?.length)row.innerPlayerList.unshift({uid:0,name:'',icon:'15',banker:true,score:0,handResults:structuredClone(record.dealerResults)});
  return row;
}
