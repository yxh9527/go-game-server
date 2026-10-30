import { requestControl } from '../../shared/tournament-control.js';
import { devControlSecret } from './control.js';
import { createTournamentIdempotency, tournamentRequestKey } from '../../shared/tournament-idempotency.js';

// Development-only idempotent payment simulator. Production must inject authority.
export function createDevMatchPayments(runtime) {
  const dedup=createTournamentIdempotency(runtime);
  const cached=authority=>Object.fromEntries(['charge','refund','award'].map(operation=>[operation,(plan,includeService)=>
    dedup.run('payment:'+tournamentRequestKey({agentId:plan.agentId,matchId:plan.matchId,operation,plan,includeService}),
      ()=>authority[operation](plan,includeService))]));
  if(runtime.config?.game_server) {
    const secret=runtime.config.match_control_secret||devControlSecret;
    const invoke=(operation,plan,more={})=>requestControl(runtime.config.game_server,secret,
      {action:'payment',agentId:plan.agentId,matchId:plan.matchId,operation,plan,...more});
    return cached({charge:plan=>invoke('charge',plan),refund:(plan,includeService)=>invoke('refund',plan,{includeService}),award:plan=>invoke('award',plan)});
  }
  const ledger = runtime.tournamentPayments ||= new Map();
  return cached({
    async award(plan) {
      const old=ledger.get(plan.key);if(old)return structuredClone(old);
      if(plan.kind!=='money'||plan.currency!=='CNY'||!Number.isSafeInteger(plan.amount)||plan.amount<=0)throw new Error('local award currency/tickets are not configured');
      const result=await runtime.rpc.common.credit(plan.userId,plan.amount);
      if(result?.ok!==true)throw new Error('award failed');
      const receipt={key:plan.key,amount:plan.amount,currency:plan.currency};ledger.set(plan.key,receipt);return structuredClone(receipt);
    },
    async charge(plan) {
      if (ledger.has(plan.key)) return structuredClone(ledger.get(plan.key));
      if (plan.ticketCount) throw new Error('development ticket payment is not configured');
      const result = plan.total ? await runtime.rpc.common.debit(plan.userId,plan.total) : { ok: true };
      if (result?.ok !== true) throw Object.assign(new Error('余额不足'),{status:409});
      const receipt = { key:plan.key, paidGold:plan.gold, paidService:plan.service, currency:plan.currency, refunded:false };
      ledger.set(plan.key,receipt); return structuredClone(receipt);
    },
    async refund(plan, includeService) {
      const receipt = ledger.get(plan.key);
      if (!receipt) return { key:plan.key,currency:plan.currency,refunded:0,uncharged:true };
      if (receipt.refunded) return structuredClone(receipt.refunded);
      const amount = receipt.paidGold + (includeService ? receipt.paidService : 0);
      const result = amount ? await runtime.rpc.common.credit(plan.userId,amount) : { ok:true };
      if (result?.ok !== true) throw new Error('refund failed');
      receipt.refunded = { key:plan.key,refunded:amount,currency:receipt.currency };
      return structuredClone(receipt.refunded);
    },
  });
}
