// ZJH action IDs differ from Holdem. Consume only the actual accepted action
// stream, with the target's original ante as evidence that it is not truncated.
export function zjhPlayerActions(events,uid){
  const unknown={known:false,voluntary:false,raised:false};
  if(!Array.isArray(events)||!events.length||!Number.isSafeInteger(uid)||uid<=0)return unknown;
  let ante=0,voluntary=false,raised=false;
  for(const event of events){
    const owner=event?.uid,op=event?.operationType??event?.operation,state=event?.gameState,bet=event?.bet??event?.currentBetScore;
    if(!Number.isSafeInteger(owner)||owner<=0||!Number.isInteger(op)||![1,2,3,4,6,7,8,9].includes(op)||!Number.isSafeInteger(bet)||bet<0)return unknown;
    if(op===1){if(state!==1||bet<=0)return unknown;}
    else if(state!==4||([3,4,6,8].includes(op)?bet<=0:bet!==0))return unknown;
    if(owner!==uid)continue;
    if(op===1){ante++;if(ante!==1||voluntary||raised)return unknown;}
    else if(!ante)return unknown;
    if([3,4,6,8].includes(op))voluntary=true;
    if(op===4)raised=true;
  }
  return ante===1?{known:true,voluntary,raised}:unknown;
}

export function zjhRecordActions(record,uid){
  const native=record?.detail?.nativeHistory;
  if(Number(record?.roomType)!==25||!native||Number(native.row?.currentInningNum)!==Number(record.inning)||Number(native.row?.gameRoomId)!==Number(record.roomId))return {known:false,voluntary:false,raised:false};
  return zjhPlayerActions(native.events,uid);
}

// Blackjack retains accepted actions on the hand, including timeout bets.
// Reduce them before publishing the settled log; never persist nested cards
// or wallet snapshots from actionList into the statistical SQL projection.
export function blackjackPlayerActions(actions,uid){
  const unknown={known:false,manualBet:false,doubled:false,split:false,insuranceBuy:false};
  if(!Array.isArray(actions)||!actions.length||!Number.isSafeInteger(uid)||uid<=0)return unknown;
  let initial=false,dealt=false,settled=false,manualBet=false,doubled=false,split=false,insuranceBuy=false;
  for(let index=0;index<actions.length;index++){
    const event=actions[index],owner=event?.uid,type=event?.actionType,state=event?.gameState,amount=event?.amount;
    if(event?.round!==index+1||!Number.isSafeInteger(owner)||owner<0||event?.banker!==(owner===0)||!Number.isInteger(type)||type<1||type>13||!Number.isSafeInteger(amount)||amount<0)return unknown;
    if(owner!==uid)continue;
    if(settled)return unknown;
    if(type===1||type===2){if(dealt||state!==2||amount<=0)return unknown;initial=true;manualBet ||= type===1;}
    else{
      if(!initial)return unknown;
      if(type===3){if(dealt||state!==3||amount!==0)return unknown;dealt=true;continue;}
      if(!dealt)return unknown;
      if(type===6){if(state!==8||amount!==0)return unknown;settled=true;}
      else if(type===12||type===13){if(state!==6||amount<=0)return unknown;if(type===12)doubled=true;else split=true;}
      else if(type===8){if(state!==4||amount<=0)return unknown;insuranceBuy=true;}
      else if(type===9||type===10){if(state!==4||amount!==0)return unknown;}
      else if(type===4||type===5||type===7){if(state!==6||amount!==0)return unknown;}
      else return unknown;
    }
  }
  return initial&&settled?{known:true,manualBet,doubled,split,insuranceBuy}:unknown;
}

export function blackjackRecordActions(record,uid){
  const native=record?.detail?.nativeHistory,fact=native?.blackjackBehavior;
  if(Number(record?.roomType)!==31||Number(native?.row?.currentInningNum)!==Number(record.inning)||Number(native?.row?.gameRoomId)!==Number(record.roomId)||fact?.version!==1||fact.playerId!==uid||fact.known!==true
    ||!['manualBet','doubled','split','insuranceBuy'].every(key=>typeof fact[key]==='boolean'))return {known:false,manualBet:false,doubled:false,split:false,insuranceBuy:false};
  return {known:true,manualBet:fact.manualBet,doubled:fact.doubled,split:fact.split,insuranceBuy:fact.insuranceBuy};
}

const unknownSeat=()=>({known:false,betOpportunity:false,manualBet:false,aboveMinimumBet:false,manualGrab:false,positiveGrab:false});
export function seatChoiceActions(roomType,hand,uid){
  if(![24,32].includes(Number(roomType))||hand?.behaviorVersion!==1||hand.settled!==true||!Number.isSafeInteger(uid)||uid<=0)return unknownSeat();
  const player=hand.players?.find(player=>player.uid===uid);if(!player)return unknownSeat();
  const niuniu=Number(roomType)===24,banker=niuniu&&hand.bankerUid===uid;
  if(niuniu&&(!Number.isSafeInteger(hand.bankerUid)||hand.bankerUid<=0||!Number.isSafeInteger(player.grab)||player.grab<0||typeof player.manualGrab!=='boolean'))return unknownSeat();
  if(!banker&&(!Number.isSafeInteger(player.bet)||player.bet<=0||typeof player.manualBet!=='boolean'||typeof player.aboveMinimumBet!=='boolean'||player.aboveMinimumBet&&!player.manualBet))return unknownSeat();
  return {known:true,betOpportunity:!banker,manualBet:!banker&&player.manualBet,aboveMinimumBet:!banker&&player.aboveMinimumBet,
    manualGrab:niuniu&&player.manualGrab,positiveGrab:niuniu&&player.manualGrab&&player.grab>0};
}

export function seatChoiceRecordActions(record,uid){
  const native=record?.detail?.nativeHistory,fact=native?.seatChoiceBehavior,type=Number(record?.roomType);
  if(![24,32].includes(type)||Number(native?.row?.currentInningNum)!==Number(record.inning)||Number(native?.row?.gameRoomId)!==Number(record.roomId)||fact?.version!==1||fact.playerId!==uid||fact.known!==true
    ||!['betOpportunity','manualBet','aboveMinimumBet','manualGrab','positiveGrab'].every(key=>typeof fact[key]==='boolean')
    ||fact.manualBet&&!fact.betOpportunity||fact.aboveMinimumBet&&!fact.manualBet||fact.positiveGrab&&!fact.manualGrab||type===32&&(!fact.betOpportunity||fact.manualGrab||fact.positiveGrab))return unknownSeat();
  return {known:true,betOpportunity:fact.betOpportunity,manualBet:fact.manualBet,aboveMinimumBet:fact.aboveMinimumBet,manualGrab:fact.manualGrab,positiveGrab:fact.positiveGrab};
}

const unknownArrangement=()=>({known:false,clientSubmitted:false,extended:false});
export function arrangementChoiceActions(hand,uid){
  if(hand?.behaviorVersion!==1||hand.settled!==true||!Number.isSafeInteger(uid)||uid<=0)return unknownArrangement();
  const player=hand.players?.find(player=>player.uid===uid);
  if(!player?.result||typeof player.clientSubmittedArrangement!=='boolean'||!Number.isSafeInteger(player.arrangementExtensions)||player.arrangementExtensions<0)return unknownArrangement();
  return {known:true,clientSubmitted:player.clientSubmittedArrangement,extended:player.arrangementExtensions>0};
}

export function arrangementRecordActions(record,uid){
  const native=record?.detail?.nativeHistory,fact=native?.arrangementBehavior;
  if(Number(record?.roomType)!==27||Number(native?.row?.currentInningNum)!==Number(record.inning)||Number(native?.row?.gameRoomId)!==Number(record.roomId)||fact?.version!==1||fact.playerId!==uid||fact.known!==true||typeof fact.clientSubmitted!=='boolean'||typeof fact.extended!=='boolean')return unknownArrangement();
  return {known:true,clientSubmitted:fact.clientSubmitted,extended:fact.extended};
}

const unknownDiscards=()=>({known:false,clientDiscard:false,serverDiscard:false});
export function mahjongDiscardActions(hand,uid){
  if(hand?.behaviorVersion!==1||hand.settled!==true||!Number.isSafeInteger(uid)||uid<=0)return unknownDiscards();
  const player=hand.players?.find(player=>player.uid===uid);
  if(!player||typeof player.clientDiscard!=='boolean'||typeof player.serverDiscard!=='boolean'||!Number.isSafeInteger(player.discardCount)||player.discardCount<0
    ||(player.discardCount>0)!==(player.clientDiscard||player.serverDiscard)||player.discardCount<Number(player.clientDiscard)+Number(player.serverDiscard))return unknownDiscards();
  return {known:true,clientDiscard:player.clientDiscard,serverDiscard:player.serverDiscard};
}

export function mahjongRecordActions(record,uid){
  const native=record?.detail?.nativeHistory,fact=native?.mahjongBehavior;
  if(![26,28,30].includes(Number(record?.roomType))||Number(native?.row?.currentInningNum)!==Number(record.inning)||Number(native?.row?.gameRoomId)!==Number(record.roomId)||fact?.version!==1||fact.playerId!==uid||fact.known!==true||typeof fact.clientDiscard!=='boolean'||typeof fact.serverDiscard!=='boolean')return unknownDiscards();
  return {known:true,clientDiscard:fact.clientDiscard,serverDiscard:fact.serverDiscard};
}
