export const isTournamentParticipant=e=>['registered','playing','eliminated','winner'].includes(e.status);
export function tournamentSnapshot(row,state) {
  return {sequence:state.seq||0,match:{...row,...(state.archived?{archived:true}:{}),...(state.manualPause?{manualPause:{paused:state.manualPause.paused,version:state.manualPause.version}}:{}),...(state.termination?{terminatedByAdmin:true,terminationReason:state.termination.reason,terminationAt:state.termination.at}:{}),...(state.invalidated?{invalidated:true,invalidReason:state.invalidated.reason,invalidAt:state.invalidated.at}:{}),...(state.frozenBlinds ? {blind_config:state.frozenBlinds} : {}),...(state.clock?{tournament_clock:state.clock}:{})},players:Object.values(state.registrations||{}).filter(isTournamentParticipant).map(e=>({
    match_id:row.id,player_id:e.userId,name:e.name,avatar:e.avatar||'',points:e.points||0,rank:e.rank||0,
    status:e.status==='registered'?1:e.status==='playing'?4:2,room_id:e.roomId||0,
    reentries_used:(e.reentries||[]).filter(x=>x.status==='admitted').length,
    paid_gold:e.plan.gold,paid_service:e.plan.service,currency:e.plan.currency,
  })),tables:state.tables||[]};
}
