export const isTournamentParticipant=e=>['registered','playing','eliminated','winner'].includes(e.status);
export function tournamentSnapshot(row,state) {
  return {sequence:state.seq||0,match:{...row,...(state.frozenBlinds ? {blind_config:state.frozenBlinds} : {})},players:Object.values(state.registrations||{}).filter(isTournamentParticipant).map(e=>({
    match_id:row.id,player_id:e.userId,name:e.name,avatar:e.avatar||'',points:e.points||0,rank:e.rank||0,
    status:e.status==='registered'?1:e.status==='playing'?4:2,room_id:e.roomId||0,
    paid_gold:e.plan.gold,paid_service:e.plan.service,currency:e.plan.currency,
  })),tables:state.tables||[]};
}
