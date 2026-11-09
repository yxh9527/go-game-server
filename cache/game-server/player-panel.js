// Development projection reads only already-settled room memory. No fixture
// hands, opponent wallets, or current uncommitted hand are returned.
export function localPlayerPanelRecords(runtime,{agentId,targetId,currency,roomType=19}){
  const records=new Map(),key=r=>[r.roomId,r.inning].join(':');
  for(const r of runtime.userCenterState?.records.values()||[]){
    if(Number(r.agentId)!==Number(agentId)||Number(r.userId)!==Number(targetId)||Number(r.roomType)!==Number(roomType)||r.currency!==currency)continue;
    const players=Array.isArray(r.detail?.firstGameList)?r.detail.firstGameList:[];
    records.set(key(r),{userId:r.userId,roomId:r.roomId,roomType:r.roomType,inning:r.inning,endedAt:r.endedAt,net:r.net,playMode:r.playMode,
      effectiveBet:r.effectiveBet,players,detail:r.detail,commonCards:r.detail?.commonCards||[],events:undefined});
  }
  for(const table of Number(roomType)===19?runtime.registry.listAgentGameRooms(agentId,'holdem'):[])for(const row of table.history||[]){
    const players=row.firstGameList||[],own=players.find(p=>Number(p.uid)===Number(targetId));if(!own||!Number.isSafeInteger(own.score))continue;
    const index=key({roomId:table.roomId,inning:row.currentInningNum}),saved=records.get(index);
    records.set(index,{userId:Number(targetId),roomId:table.roomId,inning:row.currentInningNum,endedAt:Number(row.innerEndTime)||saved?.endedAt,
      net:own.score,playMode:row.playMode,effectiveBet:saved?.effectiveBet,commonCards:own.commonPoker||[],
      players:players.map(p=>({uid:Number(p.uid),score:p.score,isWin:p.isWin,userName:p.userName,userIcon:p.userIcon,
        // Retained server-only holes may be used only for the requesting owner.
        handPais:(p.cards||p.handPais||[]).slice(0,2),showCards:p.showCards||[-1,-1],operateList:p.operateList})),
      events:Array.isArray(row.roundEvents)?row.roundEvents:undefined});
  }
  return [...records.values()];
}
