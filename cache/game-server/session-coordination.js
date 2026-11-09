import {randomUUID} from 'node:crypto';

// Adopt only authenticated, still-owned local sessions from the pre-upgrade
// dev store, whose backend was private. Never change seats, wallets or hands.
export async function adoptGameSessions(runtime,previous,next){
  const active=[...runtime.registry.sessions].filter(([ws,s])=>ws.readyState===1&&s.authenticated!==false&&!s.superseded);
  const primaries=active.filter(([,s])=>s.loginRole!=='hundred');
  for(const [ws,primary]of primaries){
    if(primary.loginId&&!await previous.verify(primary))continue;
    const adopt=async()=>{
      primary.loginId ||= randomUUID();primary.socketId ||= randomUUID();
      primary.loginAttempt=await next.beginAttempt(primary.userId);
      const lease=await next.claim(primary,{identity:primary.loginIdentity,attempt:primary.loginAttempt});
      primary.loginGroup=lease.loginId;
      const table=runtime.registry.getTable(primary.roomId,primary.agentId,primary.gameId);
      if(table)await next.updateRoom(primary,table);
      for(const [other,secondary]of active){
        if(other===ws||secondary.loginRole!=='hundred'||secondary.agentId!==primary.agentId||secondary.userId!==primary.userId
          ||secondary.loginId!==primary.loginId||!await previous.verify(secondary))continue;
        secondary.loginAttempt=await next.beginAttempt(secondary.userId);
        const pair=await next.claim(secondary,{identity:secondary.loginIdentity,allowPair:true,attempt:secondary.loginAttempt});
        secondary.loginId=pair.loginId;secondary.loginGroup=pair.loginId;
      }
    };
    if(previous.serialize)await previous.serialize(primary,adopt);else await adopt();
  }
}
