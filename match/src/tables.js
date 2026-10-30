import { rel } from './rel.js';

export async function createTournamentTables(runtime) {
  const {requestControl,controlError}=await rel(import.meta.url,'../../shared/tournament-control.js',runtime.hotVersion);
  const secret=runtime.config?.match_control_secret || (runtime.env==='dev'
    ? (await rel(import.meta.url,'../../cache/match/control.js',runtime.hotVersion)).devControlSecret : '');
  async function request(action,row,more={}) {
    return requestControl(runtime.config?.game_server,secret,{action,agentId:Number(row.agent_id||(runtime.env==='dev'?1:0)),matchId:Number(row.id),...more});
  }
  async function blindPlan(row) {
    const config=row.blinds_id?(await runtime.store.listBlinds()).find(b=>Number(b.id)===Number(row.blinds_id)):null;
    const list=config?JSON.parse(config.data||'[]'):[];
    const levels=list.length?list:[{min:row.small_blind,max:row.big_blind,bet:0,interval:row.increase_bind_time||0}];
    for(const level of levels) {
      for(const key of ['min','max','bet','interval']){
        level[key]=Number(level[key]??0);
        if(!Number.isSafeInteger(level[key])||level[key]<0)throw controlError(400,'比赛盲注配置必须是非负整数积分/秒');
      }
      if(level.min<=0||level.max<level.min)throw controlError(503,'比赛缺少有效的盲注配置');
      if(level.type&&Number(level.type)!==1)throw controlError(503,'比赛休息级别尚未开放');
    }
    if(levels.length>1&&levels.slice(0,-1).some(l=>!l.interval))throw controlError(400,'多级盲注必须配置升级间隔');
    return levels;
  }
  return {request,blindPlan,
    async start(row,players,frozenLevels){
      const levels=frozenLevels||await blindPlan(row);
      return (await request('start',row,{config:{initPoint:Number(row.init_point),forceShowCard:Number(row.force_show_card)!==0,
        name:row.championship_name||'[]',levels,startedAt:Number(row.start_time)},players:players.map(p=>({uid:p.userId,name:p.name,icon:p.avatar,point:p.points}))})).tables;
    },
    status:row=>request('status',row),
    advance:(row,checkpoint)=>request('advance',row,checkpoint),
    awards:(row,results)=>request('awards',row,{results}),
  };
}
