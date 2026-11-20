const names={24:'qznn',25:'ctjh',26:'jsmj',27:'sss',28:'csmj',30:'hzxl',31:'bj21',32:'sgya'};
const parse=value=>{try{return typeof value==='string'?JSON.parse(value):value;}catch{return null;}};
const list=value=>{const data=parse(value);return Array.isArray(data)?data:[];};

function visiblePlayer(source,viewer){
  const row=structuredClone(source),own=Number(row.uid)===viewer;
  if(own)return row;
  // Legacy result rows may contain internal holes alongside public showCards.
  // The replay recipient may use only the explicitly public version.
  const shown=Array.isArray(row.showCards)?row.showCards:[];
  const hidden=shown.length===0||shown.some(card=>Number(card)<0);
  const privateCards=new Set(['handPais','cards','handCards','hole','holeCardList','cardTypePokers','handCardListWithLaiZi','commonPoker','frontCards','middleCards','backCards','handCardList','cardList']);
  function mask(value){
    if(!value||typeof value!=='object')return;
    for(const [key,item]of Object.entries(value)){
      if(privateCards.has(key)&&Array.isArray(item))value[key]=shown.slice();
      else if(item&&typeof item==='object')mask(item);
    }
  }
  mask(row);
  if(hidden){delete row.cardTypeInfo;delete row.evalResult;if(row.cardTypeId!=null)row.cardTypeId=0;if(row.secondCardTypeId!=null)row.secondCardTypeId=0;}
  row.operateList=list(row.operateList).map(operation=>{
    const copy=structuredClone(operation);
    if(Array.isArray(copy.cards)&&Number(copy.gameState)===3)copy.cards=shown.slice();
    return copy;
  });
  return row;
}

// Convert only facts already present in the owner's original settled log.
// Older records can show a final result even if full action replay was absent.
export function nativeHistorySnapshot(record){
  const detail=parse(record?.detail);
  if(detail?.nativeHistory?.row)return detail.nativeHistory;
  const type=Number(record?.roomType),viewer=Number(record?.userId);
  if(!names[type]||!detail||!(viewer>0)||!(Number(record.inning)>0)||!(Number(record.endedAt)>0))return null;
  const end=parse(detail.gameEndData);
  const original=list(detail.firstGameList).length?list(detail.firstGameList):list(end?.playerList||end?.resultList);
  if(!original.length)return null;
  if(type!==31&&!original.some(player=>Number(player.uid)===viewer))return null;
  // These other seat games publish their actual final hands at settlement.
  // Jinhua alone among these legacy formats may keep a folded hand private.
  const players=original.map(player=>type===25?visiblePlayer(player,viewer):structuredClone(player));
  const row={gameRoomId:Number(record.roomId),currentInningNum:Number(record.inning),innerEndTime:Number(record.endedAt),endTime:Number(record.endedAt),
    firstGameList:players,secondGameList:list(detail.secondGameList),currentInningJoin:true,
    ...(detail.reportMsg?{reportMsg:structuredClone(detail.reportMsg)}:{})};
  const room=record.room||{};
  if(Number.isSafeInteger(detail.pot))row.pot=detail.pot;
  if(typeof detail.excellentGame==='boolean')row.excellentGame=detail.excellentGame;
  if(type===24){
    row.seeCardNo=detail.seeCardNo??room.seeCardNo??players.find(player=>Number(player.uid)===viewer)?.seeCardNo;row.playMode=Number(record.playMode)||0;
    for(const player of players){player.seeCardNo=row.seeCardNo;player.posType=player.banker?1:0;player.cardTypePokers=list(player.handPais).slice();}
  }
  if(type===27){
    const comparison=parse(detail.compareResult);
    if(!comparison)return null;
    row.compareResult=structuredClone(comparison);row.playMode=Number(record.playMode)||0;
    if(detail.horseCardPosition!=null)row.horseCardPosition=detail.horseCardPosition;
  }
  if(type===31){
    const dealer=original.find(player=>Number(player.uid)===0&&player.banker&&Array.isArray(player.handResults));
    const dealerResults=list(detail.dealerResults);
    if(!dealer&&!dealerResults.length)return null;
    row.firstGameList=players.filter(player=>Number(player.uid)>0).map(player=>({...player,name:player.userName||player.name,icon:player.userIcon||player.icon,
      banker:false,displaySeat:Number(record.playMode)?([1,2,3,5,6][player.pos]??'未记录'):player.pos,insuranceBet:player.insuranceAmount??player.insuranceBet}));
    row.firstGameList.unshift(dealer?structuredClone(dealer):{uid:0,name:'',icon:'15',banker:true,score:0,insuranceBet:0,insuranceProfit:0,handResults:structuredClone(dealerResults)});
    if(detail.bankerSettles)row.bankerSettles=structuredClone(detail.bankerSettles);
  }
  if([26,28,30].includes(type)){
    if(!Array.isArray(detail.resultList)||!Number.isInteger(detail.bankerPos))return null;
    const fields=['resultList','winUid','dianPaoUid','huType','settleType','bankerPos','addFanCard','last5Cards','zhaNiaoCards','zhaNiaoPlayers','zhaNiaoAnchorPos',
      'fanjiangCards','fanjiangScore','fanjiangFan','addCardFan','winHuTypes','huTotalFan','finalHuScoreMap','finalHuFanMap','startHuScoreMap','midHuScoreMap','startHuFanMap','midHuFanMap','zhaNiaoHitCountMap'];
    for(const key of fields)if(detail[key]!==undefined)row[key]=structuredClone(detail[key]);
    row.playerList=players;row.bankerPos=detail.bankerPos;
  }
  return {row,finalOnly:true,ante:room.ante??detail.ante??parse(detail.blind)?.ante};
}
