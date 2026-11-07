const asMs=n=>Number(n)>0&&Number(n)<100000000000?Number(n)*1000:Number(n)||0;
export function userCenterMatch(row,state,query){
  const own=state.registrations?.[query.userId],start=asMs(row.start_time);
  if(!own||Number(own.userId)!==Number(query.userId)||['pending','failed'].includes(own.status)
    ||Number(row.agent_id)!==Number(query.agentId)||(row.currency||'CNY')!==query.currency
    ||start<query.startTime||start>query.endTime||query.kind==='match'&&Number(row.id)!==Number(query.roomId))return null;
  const reward=uid=>(state.prizes||[]).filter(p=>p.status==='paid'&&p.receipt&&p.receipt.amount===p.plan.amount&&p.receipt.currency===p.plan.currency&&Number(p.plan.userId)===Number(uid));
  const amounts=uid=>({point:reward(uid).filter(p=>p.plan.kind==='money'&&p.plan.currency===query.currency).reduce((n,p)=>n+p.plan.amount,0),ticketNum:reward(uid).filter(p=>p.plan.kind==='ticket').reduce((n,p)=>n+p.plan.amount,0)});
  const ranks=Object.values(state.registrations||{}).filter(e=>e.rank>0&&!['pending','failed','refunded'].includes(e.status)).map(e=>({uid:e.userId,rank:e.rank,userName:e.name||String(e.userId),icon:e.avatar||'',...amounts(e.userId)})).sort((a,b)=>a.rank-b.rank);
  const mine=amounts(own.userId),paid=Number(own.receipt?.paidGold||0)+Number(own.receipt?.paidService||0),refund=Number(own.refund?.refunded||0);
  return {id:Number(row.id),championshipName:row.championship_name,roomType:101,gameType:Number(row.game_type)||19,startDate:start,
    status:Number(row.state),myRank:own.rank>0?own.rank:Number(row.state)===3?0:-1,rewardAmount:mine.point,ticketNum:mine.ticketNum,
    currentPlayer:Number(row.current_player)||0,initPoint:Number(row.init_point)||0,registerGold:Number(row.register_gold)||0,
    blindType:Number(row.blind_type)||0,forceShowCard:Boolean(Number(row.force_show_card)),gameTime:Math.max(0,asMs(row.end_time)-start),
    increaseBindTime:Number(row.increase_bind_time)||0,MTTUserRanks:ranks,myUserRank:ranks.find(r=>Number(r.uid)===Number(query.userId))||{uid:own.userId,userName:own.name,icon:own.avatar||''},
    net:mine.point-paid+refund};
}
