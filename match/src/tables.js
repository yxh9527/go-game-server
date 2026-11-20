import { rel } from './rel.js';

export async function createTournamentTables(runtime) {
  const {requestControl,controlError}=await rel(import.meta.url,'../../shared/tournament-control.js',runtime.hotVersion);
  const {normalizeTournamentLevels}=await rel(import.meta.url,'../../shared/tournament-blinds.js',runtime.hotVersion);
  const secret=runtime.config?.match_control_secret || (runtime.env==='dev'
    ? (await rel(import.meta.url,'../../cache/match/control.js',runtime.hotVersion)).devControlSecret : '');
  async function request(action,row,more={}) {
    return requestControl(runtime.config?.game_server,secret,{action,agentId:Number(row.agent_id||(runtime.env==='dev'?1:0)),matchId:Number(row.id),...more});
  }
  async function blindPlan(row) {
    const config=row.blinds_id?(await runtime.store.listBlinds()).find(b=>Number(b.id)===Number(row.blinds_id)):null;
    const list=config?JSON.parse(config.data||'[]'):[];
    const levels=list.length?list:[{min:row.small_blind,max:row.big_blind,bet:0,interval:row.increase_bind_time||0}];
    try{return normalizeTournamentLevels(levels);}catch(error){throw controlError(400,error.message);}
  }
  return {request,blindPlan,
    async start(row,players,frozenLevels){
      const levels=frozenLevels||await blindPlan(row);
      const result=await request('start',row,{config:{initPoint:Number(row.init_point),forceShowCard:Number(row.force_show_card)!==0,
        currency:row.currency||'CNY',
        name:row.championship_name||'[]',levels,startedAt:Number(row.start_time),rebuyLimit:Number(row.rebuy_time||0),
        lateLevel:Number(row.delay_register_level||0),lateSeconds:Number(row.delay_register_time||0)},players:players.map(p=>({uid:p.userId,name:p.name,icon:p.avatar,point:p.points}))});
      if(Array.isArray(result.tables))Object.defineProperty(result.tables,'processId',{value:result.processId});
      return result.tables;
    },
    status:row=>request('status',row),
    pause:(row,command)=>request('pause',row,command),
    advance:(row,checkpoint)=>request('advance',row,checkpoint),
    awards:(row,results)=>request('awards',row,{results,deliveryVersion:2}),
    cleanup:row=>request('cleanup',row),
    invalidate:row=>request('invalidate',row),
  };
}
