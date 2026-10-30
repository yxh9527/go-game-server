import { controlError } from '../../shared/tournament-control.js';

// The game process owns local cash balances. Match and hall must not charge
// their separate in-memory RPC stores and then pretend those wallets are shared.
export function createDevTournamentWallet(runtime,ioOf) {
  const state=runtime.localMatchWallet ||= {ledger:new Map(),queues:new Map()};
  async function apply(body){
    const p=body.plan;
    if(!p||typeof p.key!=='string'||p.key.length>200||p.agentId!==body.agentId||p.matchId!==body.matchId
      ||!Number.isSafeInteger(p.userId)||p.userId<=0||p.currency!=='CNY')throw controlError(400,'本地比赛支付参数无效或币种未配置');
    if(p.ticketCount)throw controlError(503,'本地比赛门票支付尚未配置');
    const profile=await runtime.gateway.getLoginData(p.userId);
    if(Number(profile.agentId)!==p.agentId)throw controlError(403,'比赛支付代理不匹配');
    const previous=state.ledger.get(p.key);
    if(previous&&JSON.stringify(previous.plan)!==JSON.stringify(p))throw controlError(409,'重复支付键金额冲突');
    if(body.operation==='award'&&previous)return structuredClone(previous.receipt);
    if(body.operation==='charge'&&previous)return structuredClone(previous.receipt);
    if(body.operation==='refund'&&previous?.refund)return structuredClone(previous.refund);
    if(body.operation==='refund'&&!previous)return {key:p.key,currency:p.currency,uncharged:true,refunded:0};
    const session={userId:p.userId,agentId:p.agentId,wallet:0};await runtime.wallet.load(session);
    let receipt;
    if(body.operation==='charge'){
      for(const n of [p.gold,p.service,p.total])if(!Number.isSafeInteger(n)||n<0)throw controlError(400,'报名金额无效');
      if(p.gold+p.service!==p.total)throw controlError(400,'报名费用合计不匹配');
      const result=runtime.wallet.debit(session,p.total);
      if(result?.ok!==true)throw controlError(409,'余额不足');
      receipt={key:p.key,paidGold:p.gold,paidService:p.service,currency:p.currency};
      state.ledger.set(p.key,{plan:structuredClone(p),receipt});
    }else if(body.operation==='refund'){
      const amount=previous.receipt.paidGold+(body.includeService?previous.receipt.paidService:0);
      const result=runtime.wallet.credit(session,amount);if(result?.ok!==true)throw controlError(503,'退款失败');
      receipt={key:p.key,refunded:amount,currency:p.currency};previous.refund=receipt;
    }else if(body.operation==='award'){
      if(p.kind!=='money'||!Number.isSafeInteger(p.amount)||p.amount<=0)throw controlError(503,'本地门票奖励尚未配置');
      const result=runtime.wallet.credit(session,p.amount);if(result?.ok!==true)throw controlError(503,'奖励发放失败');
      receipt={key:p.key,amount:p.amount,currency:p.currency};state.ledger.set(p.key,{plan:structuredClone(p),receipt});
    }else throw controlError(400,'未知比赛资金操作');
    await runtime.wallet.persist(session);
    for(const [ws,s] of runtime.registry.sessions)if(s.userId===p.userId&&s.agentId===p.agentId){
      s.wallet=session.wallet;ioOf({roomId:s.roomId,agentId:s.agentId,gameId:s.gameId}).send(ws,9212,session.wallet);
    }
    return receipt;
  }
  return body=>{
    const key=body.plan?.userId,task=(state.queues.get(key)||Promise.resolve()).catch(()=>{}).then(()=>apply(body));
    state.queues.set(key,task);task.finally(()=>{if(state.queues.get(key)===task)state.queues.delete(key);}).catch(()=>{});
    return task;
  };
}
