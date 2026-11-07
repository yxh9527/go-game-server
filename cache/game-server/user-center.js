// Read-only compatibility for room histories recorded before user-center hooks.
// Missing historical account balances stay absent; never infer them from today.
import { holdemUserCenterDetail } from '../../shared/user-center.js';
export function legacyUserCenterRecords(runtime,query){
  const records=[];
  const savedRecords=new Map([...(runtime.userCenterState?.records.values()||[])]
    .filter(r=>Number(r.userId)===Number(query.userId)&&Number(r.agentId)===Number(query.agentId))
    .map(r=>[[r.gameId,r.roomId,r.inning].join(':'),r]));
  for(const table of runtime.registry.tables.values()){
    if(Number(table.agentId)!==Number(query.agentId)||table.mtt)continue;
    for(const row of [...(table.history||[]),...(table.hundredHistory||[])]){
      const inning=Number(row.currentInningNum||row.inning||row.currInning)||1;
      const saved=savedRecords.get([table.gameId,table.roomId,inning].join(':'));
      const endedAt=Number(row.innerEndTime||row.createdAt||row.endTime||saved?.endedAt);if(!Number.isSafeInteger(endedAt)||endedAt<=0)continue;
      let raw=row.firstGameList||row.players||row.result?.playerList||row.result?.resultList||[];
      const own=raw.find(p=>Number(p.uid)===Number(query.userId));const bets=row.personal?.[query.userId];
      let net=Number(own?.score),bet=Number(own?.xiaZhuData||0);
      if(bets){net=Object.values(bets).reduce((n,b)=>n+Number(b.realScore),0);bet=Object.values(bets).reduce((n,b)=>n+Number(b.betScore),0);}
      if(!own&&!bets)continue;if(!Number.isSafeInteger(net)||!Number.isSafeInteger(bet)||bet<0)continue;
      const players=raw.map(p=>{
        const holdem=Number(table.roomType)===19,own=Number(p.uid)===Number(query.userId);
        const hole=holdem?(own?(p.cards?.slice(0,2)||p.handPais||[]):(p.showCards?.length?p.showCards:[-1,-1]))
          :own?(p.ownCards||p.showCards||p.handPais||[]):(p.showCards||[]);
        const commonPoker=holdem?(p.commonPoker||[]):[];
        const operateList=holdem?(p.operateList||[]).map(({cards,...action})=>({...action})):[];
        if(holdem){operateList.push({gameState:3,operate:0,cards:hole.slice()});
          for(const [gameState,start,end]of [[5,0,3],[7,3,4],[9,4,5]])if(commonPoker.length>=end)operateList.push({gameState,operate:0,cards:commonPoker.slice(start,end)});}
        return {uid:Number(p.uid),pos:p.pos,posName:p.posName,userName:p.userName||p.name||p.userInfo?.name||String(p.uid),userIcon:p.userIcon||p.icon||p.userInfo?.icon||'',
          score:p.score,isWin:p.isWin,cardTypeId:p.cardTypeId,cardTypePokers:p.cardTypeInfo?.handCardList||[],
          handPais:hole,showCards:p.showCards||[],commonPoker,operateList};
      });
      records.push({id:['legacy',table.agentId,table.gameId,table.roomId,inning,query.userId].join(':'),userId:Number(query.userId),agentId:Number(query.agentId),
        currency:query.currency,gameId:table.gameId,roomType:Number(table.roomType),roomId:Number(table.roomId),inning,endedAt,playMode:Number(table.playMode)||0,
        effectiveBet:bet,net,privateRoom:false,room:{ante:Number(table.ante)||0,smallBlind:Number(table.smallBlind)||0,bigBlind:Number(table.bigBlind)||0},
        players:players.map(p=>({uid:p.uid,score:p.score,userInfo:{uid:p.uid,name:p.userName,icon:p.userIcon}})),
        detail:{...(row.result||{}),gameRoomId:table.roomId,currInning:inning,firstGameList:players,
          ...(Number(table.roomType)===19?holdemUserCenterDetail(players,query.userId):{}),...(bets?{betDetailTableMap:structuredClone(bets)}:{})}});
    }
  }
  return records;
}
