import { timingSafeEqual } from 'node:crypto';

const fail=(status,message)=>Object.assign(new Error(message),{status});
function sameToken(value,expected) {
  if(typeof value!=='string'||typeof expected!=='string'||!expected)return false;
  const a=Buffer.from(value),b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
function agentId(value) {
  if(!['number','string'].includes(typeof value)||value==='')throw fail(400,'agent_id 必须为正整数');
  const id=Number(value);
  if(!Number.isSafeInteger(id)||id<=0)throw fail(400,'agent_id 必须为正整数');
  return id;
}

export function createAdminScope(runtime) {
  const config=runtime.config||{},agents=config.admin_agents||[];
  if(!Array.isArray(agents))throw fail(503,'admin_agents 配置无效');
  const tokens=new Set(config.admin_token?[config.admin_token]:[]);
  for(const row of agents){
    agentId(row.agent_id);
    if(typeof row.token!=='string'||!row.token||tokens.has(row.token))throw fail(503,'代理管理令牌必须非空且唯一');
    tokens.add(row.token);
  }
  return (req,_res,next)=>{
    try{
      const token=req.get('X-Admin-Token');
      const principal=agents.find(row=>sameToken(token,row.token));
      const platform=sameToken(token,config.admin_token);
      const local=runtime.env==='dev'&&!config.admin_token&&!agents.length;
      if(!principal&&!platform&&!local)throw fail(403,'管理凭证无效');
      const scoped=/^\/(matches|schedules)(\/|$)/.test(req.path);
      // Shared financial/template configuration is platform-admin-only until
      // its authoritative schema supports ownership; agent keys cannot edit it.
      if(!scoped){if(principal)throw fail(403,'此管理功能需要平台权限');return next();}
      const requested=[req.get('X-Agent-Id'),req.query.agent_id,req.body?.agent_id,req.body?.match?.agent_id]
        .filter(value=>value!==undefined).map(agentId);
      const selected=principal?agentId(principal.agent_id):requested[0]??(local?1:0);
      if(!selected)throw fail(400,'请选择要管理的 agent_id');
      if(requested.some(id=>id!==selected))throw fail(403,'无权管理其他代理的比赛');
      req.adminAgentId=selected;
      next();
    }catch(error){next(error);}
  };
}
