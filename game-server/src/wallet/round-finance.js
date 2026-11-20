import {createHash,randomUUID} from 'node:crypto';
import {bindRoundGameRoute} from '../../../shared/rpc/game-routes.js';
import {scoreToMoney,moneyToScore} from './money-format.js';
export {scoreToMoney,moneyToScore};

const stateKey=Symbol.for('gogame.lottery.round-finance.v1');
const fail=(message,code='FINANCE_REJECTED')=>Object.assign(new Error(message),{code,status:503});
const accountKey=item=>Number(item.userId)+':'+item.currencyType;
function canonical(value){
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){if(!Number.isFinite(value))throw fail('Nonfinite game result');return JSON.stringify(value);}
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  throw fail('Game result must contain JSON values');
}
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const isUncertain=error=>error?.uncertain||[1,2,4,13,14].includes(Number(error?.code))||[502,503,504].includes(error?.status);

export function createRoundFinance(common,{routes,clock=Date.now}={}){
  const owner=common[stateKey] ||= {rounds:new WeakMap()};
  function state(table,round){
    let current=owner.rounds.get(round);
    if(!current){
      const route=bindRoundGameRoute(round,routes,table.cfg);
      if(!route)throw fail('Financial game mapping required');
      const rawLevel=table.cfg?.finance_level,level=Number(rawLevel);
      if(rawLevel==null||rawLevel==='')throw fail('Explicit financial pool level required','FINANCE_LEVEL_MISSING');
      if(!Number.isInteger(level)||level<0||level>0xffffffff)throw fail('Explicit financial pool level required','FINANCE_LEVEL_MISSING');
      current={route,roundId:'gg-'+randomUUID(),agent:Number(table.agentId),level,revision:0,digest:'',sequence:0,
        phase:'BETTING',accounts:new Map(),commands:new WeakMap(),tail:Promise.resolve(),reservation:null,settlement:null};
      if(!Number.isInteger(current.agent)||current.agent<0||current.agent>0xffffffff)throw fail('Invalid trusted agent');
      owner.rounds.set(round,current);
    }
    return current;
  }
  const routeOf=s=>({roundId:s.roundId,agent:s.agent,gameId:s.route.number,level:s.level});
  async function invoke(s,method,request){
    try{return await common.finance(method,request,s.agent);}
    catch(error){
      if(!isUncertain(error))throw error;
      // Query before an identical retry. Never invent a second bet/settlement
      // ID after a timeout. The backend owns persistence and deduplication.
      let snapshot;
      try{snapshot=await common.finance('getRoundFinanceState',{roundId:s.roundId},s.agent);}
      catch(queryError){throw Object.assign(fail('Financial outcome could not be confirmed','FINANCE_CONFIRMATION_REQUIRED'),{cause:queryError,uncertain:true});}
      if(!snapshot||![0,10].includes(snapshot.code))throw Object.assign(fail('Financial state query failed','FINANCE_CONFIRMATION_REQUIRED'),{uncertain:true});
      if(method==='renewReservation'&&snapshot.code===0&&snapshot.state==='EXPIRED')throw fail('Reservation expired','FINANCE_RESERVATION_EXPIRED');
      // Immutable request is retried once only after the authoritative query.
      // Even a completed settlement is retried with its original ID to obtain
      // original item results, rather than infer balances from a later read.
      try{return await common.finance(method,request,s.agent);}
      catch(retryError){throw Object.assign(fail('Financial outcome requires confirmation','FINANCE_CONFIRMATION_REQUIRED'),{cause:retryError,uncertain:true});}
    }
  }
  function check(response){if(!response||response.code!==0)throw fail(response?.reason||'Financial business request rejected');return response;}
  function enqueue(s,work){
    const task=s.tail.catch(()=>{}).then(()=>{
      if(s.blocked)throw fail('Round financial state requires confirmation','FINANCE_CONFIRMATION_REQUIRED');
      return work();
    });
    s.tail=task;task.catch(error=>{if(error.uncertain||error.code==='FINANCE_RESPONSE_INVALID')s.blocked=true;});return task;
  }
  function validPlayer(s,session){
    if(session?.bot||Number(session?.agentId)!==s.agent||!Number.isInteger(Number(session.userId))||Number(session.userId)<=0||Number(session.userId)>0xffffffff
      ||typeof session.currency!=='string'||!session.currency)throw fail('Financial account identity mismatch');
    return {userId:Number(session.userId),currencyType:session.currency};
  }
  function validateHeader(s,response){
    if(response.roundId!==s.roundId)throw fail('Financial round response mismatch','FINANCE_RESPONSE_INVALID');
  }
  function settlementItems(s,results,outcome){
    const items=results.map(item=>{
      const account=validPlayer(s,item.session),active=s.accounts.get(accountKey(account));
      if(!active)throw fail('Settlement contains an account without accepted wagers');
      if(item.netScore!==undefined){
        if(![31,58,59].includes(Number(s.route.roomType))||active.amount!==0||!item.carry||!Number.isSafeInteger(item.netScore))throw fail('Invalid funded banker result');
        const effective=Math.abs(item.netScore);
        return {...account,betAmount:scoreToMoney(effective),payout:scoreToMoney(effective+item.netScore),profit:scoreToMoney(item.netScore,true),netScore:scoreToMoney(item.netScore,true),pump:'0.00',carry:{...item.carry},record:canonical(item.record??outcome)};
      }
      return {...account,betAmount:scoreToMoney(active.amount),payout:scoreToMoney(item.payout),
        profit:scoreToMoney(item.payout-active.amount,true),pump:scoreToMoney(item.pump||0),record:canonical(item.record??outcome),
        ...(item.carry?{carry:{...item.carry}}:{})};
    }).sort((a,b)=>a.userId-b.userId||a.currencyType.localeCompare(b.currencyType));
    if(new Set(items.map(accountKey)).size!==items.length||items.length!==s.accounts.size)throw fail('Settlement must cover every active account exactly once');
    return items;
  }
  async function reserveNow(s,items,outcomeHash){
    // A display report is captured only when the actual hand settles. It may
    // be attached after card revelation; the original game result and all
    // economic fields must still agree with the earlier reservation.
    const reservedItems=items.map(item=>{
      let source;try{source=JSON.parse(item.record);}catch{return item;}
      if(!source||typeof source!=='object'||Array.isArray(source)||!Object.hasOwn(source,'completedDisplayReport'))return item;
      const {completedDisplayReport,...record}=source;
      return {...item,record:canonical(record)};
    });
    const signature=hash({items:reservedItems,outcomeHash});
    if(s.reservation){
      if(s.reservation.signature!==signature)throw fail('Reserved game outcome changed');
      if(s.reservation.expiresAt<=Math.floor(clock()/1000))throw fail('Reservation expired','FINANCE_RESERVATION_EXPIRED');
      return;
    }
    if(!items.length)return;
    const request={...routeOf(s),requestId:randomUUID(),betDigest:s.digest,outcomeHash,timeoutSeconds:60,
      items:items.map(({userId,currencyType,payout,netScore})=>({userId,currencyType,payout:netScore!==undefined?(netScore.startsWith('-')?'0.00':netScore):payout}))};
    const reserved=check(await invoke(s,'prePay',request));validateHeader(s,reserved);
    if(reserved.success!==true||reserved.state!=='RESERVED'||!reserved.reservationId||reserved.betDigest!==s.digest
      ||reserved.outcomeHash!==outcomeHash||Number(reserved.expiresAt)<=Math.floor(clock()/1000))
      throw fail('Reservation response mismatch','FINANCE_RESPONSE_INVALID');
    s.reservation={id:reserved.reservationId,expiresAt:Number(reserved.expiresAt),outcomeHash,signature};s.phase='RESERVED';
  }
  return Object.freeze({
    identity(table,round){const s=state(table,round);return Object.freeze({...routeOf(s),symbol:s.route.symbol});},
    reserve(table,round,results,outcome){
      const s=state(table,round),items=settlementItems(s,results,outcome),outcomeHash=hash(outcome);
      return enqueue(s,()=>reserveNow(s,items,outcomeHash));
    },
    settleNet(table,round,results,outcome){
      const s=state(table,round);
      if(![24,26,27,28,30].includes(Number(s.route.roomType)))throw fail('Net settlement is not available for this game');
      const items=results.map(result=>{
        const account=validPlayer(s,result.session),registered=s.accounts.get(accountKey(account));
        if(!registered||registered.amount!==0||!result.carry)throw fail('Net settlement requires a registered carry account');
        const effective=Math.abs(result.score);
        return {...account,betAmount:scoreToMoney(effective),payout:scoreToMoney(effective+result.score),
          profit:scoreToMoney(result.score,true),netScore:scoreToMoney(result.score,true),pump:scoreToMoney(result.pump||0),
          carry:{...result.carry},record:canonical(result.record??outcome)};
      }).sort((a,b)=>a.userId-b.userId||a.currencyType.localeCompare(b.currencyType));
      if(items.length!==s.accounts.size||new Set(items.map(accountKey)).size!==items.length)throw fail('Net settlement must include every registered account');
      const outcomeHash=hash(outcome),signature=hash({items,outcomeHash,mode:'SEAT_NET'});
      if(s.settlement){if(s.settlement.signature!==signature)throw fail('Net settlement content changed');return s.settlement.task;}
      const settlement={id:randomUUID(),signature};s.settlement=settlement;
      settlement.task=enqueue(s,async()=>{
        if(!items.length){s.phase='SETTLED';return {ok:true,balances:new Map()};}
        const response=check(await invoke(s,'settlement',{...routeOf(s),settlementId:settlement.id,betDigest:s.digest,
          reservationId:'',mode:'SEAT_NET',outcomeHash,items}));validateHeader(s,response);
        if(response.state!=='SETTLED'||response.settlementId!==settlement.id||!Array.isArray(response.items)||response.items.length!==items.length)
          throw fail('Net settlement response mismatch','FINANCE_RESPONSE_INVALID');
        const balances=new Map();
        for(const item of response.items){if(item.code!==0||balances.has(item.userId)||!items.some(expected=>expected.userId===item.userId))
          throw fail('Net settlement account mismatch','FINANCE_RESPONSE_INVALID');balances.set(item.userId,moneyToScore(item.currency));}
        s.phase='SETTLED';return {ok:true,balances};
      });return settlement.task;
    },
    bet(table,round,session,bets,operation={},carry){
      const s=state(table,round),account=validPlayer(s,session);
      if(!Array.isArray(bets)||!bets.length)throw fail('Empty wager');
      const normalized=bets.map(b=>({amount:scoreToMoney(b.amount),areaId:String(b.areaId??'')}));
      const binding=carry?{token:carry.token,tableKey:carry.tableKey,revision:carry.revision}:null;
      if(binding&&(bets.length!==1||!binding.token||!binding.tableKey||!Number.isSafeInteger(binding.revision)||binding.revision<0))throw fail('Invalid seat carry wager binding');
      const signature=hash({account,bets:normalized,carry:binding}),previous=s.commands.get(operation);
      if(previous){if(previous.signature!==signature)throw fail('Wager operation changed');return previous.task;}
      const record={signature};s.commands.set(operation,record);
      record.task=enqueue(s,async()=>{
        if(!['BETTING','RESERVED'].includes(s.phase)||s.settlement)throw fail('Round no longer accepts wagers');
        const items=normalized.map(item=>({...account,...item,betId:s.roundId+':rev:'+s.revision+':'+(++s.sequence),...(binding?{carry:binding}:{})}));
        const request={...routeOf(s),requestId:randomUUID(),items};
        const response=check(await invoke(s,'bet',request));validateHeader(s,response);
        if(!Array.isArray(response.items)||response.items.length!==items.length||typeof response.betDigest!=='string'||!response.betDigest)
          throw fail('Incomplete bet response','FINANCE_RESPONSE_INVALID');
        let accepted=0,total=0,balance;
        for(let i=0;i<items.length;i++){
          const item=response.items[i];
          if(item.betId!==items[i].betId||item.userId!==account.userId)throw fail('Bet account response mismatch','FINANCE_RESPONSE_INVALID');
          if(item.accepted&&item.code===0){accepted++;total+=moneyToScore(normalized[i].amount);balance=moneyToScore(item.currency);}
          else if(item.accepted||item.code===0)throw fail('Inconsistent bet response','FINANCE_RESPONSE_INVALID');
        }
        s.digest=response.betDigest;s.phase=response.state;
        if(accepted!==items.length){
          if(accepted)throw Object.assign(fail('Some wagers committed; round requires confirmation','FINANCE_CONFIRMATION_REQUIRED'),{uncertain:true});
          return {ok:false};
        }
        if(!Number.isSafeInteger(total))throw fail('Wager total overflow','FINANCE_RESPONSE_INVALID');
        const key=accountKey(account),prior=s.accounts.get(key);
        const amount=(prior?.amount||0)+total;
        if(!Number.isSafeInteger(amount))throw fail('Round wager total overflow','FINANCE_RESPONSE_INVALID');
        s.accounts.set(key,{...account,amount});
        return {ok:true,balance,betDigest:s.digest};
      });
      return record.task;
    },
    cancel(table,round,session,operation={}){
      const s=state(table,round),account=validPlayer(s,session),prior=s.commands.get(operation),signature=hash(account);
      if(prior){if(prior.signature!==signature)throw fail('Cancellation operation changed');return prior.task;}
      const record={signature};s.commands.set(operation,record);
      record.task=enqueue(s,async()=>{
        if(s.phase!=='BETTING'||s.settlement)throw fail('Cancellation only allowed before reservation');
        const active=s.accounts.get(accountKey(account));if(!active)return {ok:true,refund:0};
        const request={...routeOf(s),...account,requestId:randomUUID(),expectedBetDigest:s.digest};
        const response=check(await invoke(s,'cancelBet',request));validateHeader(s,response);
        if(response.success!==true||moneyToScore(response.refundAmount)!==active.amount||!Number.isSafeInteger(Number(response.betRevision))
          ||Number(response.betRevision)!==s.revision+1||response.state!=='BETTING'||!response.betDigest)
          throw fail('Cancellation response mismatch','FINANCE_RESPONSE_INVALID');
        s.revision=Number(response.betRevision);s.digest=response.betDigest;s.accounts.delete(accountKey(account));
        return {ok:true,refund:active.amount,balance:moneyToScore(response.currency)};
      });return record.task;
    },
    settle(table,round,results,outcome,{mode='NORMAL'}={}){
      const s=state(table,round),outcomeHash=hash(outcome);
      if(results.some(item=>item.netScore!==undefined))mode='BANKER_NET';
      if(!['NORMAL','VOID_REFUND','BANKER_NET'].includes(mode))throw fail('Invalid settlement mode');
      const items=settlementItems(s,results,outcome);
      const signature=hash({items,outcomeHash,mode});
      if(s.settlement){if(signature!==s.settlement.signature)throw fail('Settlement content changed');return s.settlement.task;}
      const settlement={signature,id:randomUUID()};s.settlement=settlement;
      settlement.task=enqueue(s,async()=>{
        if(!items.length){s.phase='SETTLED';return {ok:true,balances:new Map()};}
        if(mode==='NORMAL'||mode==='BANKER_NET')await reserveNow(s,items,outcomeHash);
        const response=check(await invoke(s,'settlement',{...routeOf(s),settlementId:settlement.id,
          reservationId:s.reservation?.id||'',betDigest:s.digest,outcomeHash,mode,items}));validateHeader(s,response);
        if(response.settlementId!==settlement.id||response.state!==(mode==='VOID_REFUND'?'VOIDED':'SETTLED')||!Array.isArray(response.items)
          ||response.items.length!==items.length)throw fail('Settlement response mismatch','FINANCE_RESPONSE_INVALID');
        const balances=new Map();
        for(const item of response.items){
          if(item.code!==0||!items.some(expected=>expected.userId===item.userId)||balances.has(item.userId))
            throw fail('Settlement account mismatch','FINANCE_RESPONSE_INVALID');
          balances.set(item.userId,moneyToScore(item.currency));
        }
        s.phase=response.state;return {ok:true,balances};
      });return settlement.task;
    },
    renew(table,round){
      const s=state(table,round);return enqueue(s,async()=>{
        if(s.phase!=='RESERVED'||!s.reservation||s.reservation.expiresAt-Math.floor(clock()/1000)>40)return;
        const response=check(await invoke(s,'renewReservation',{...routeOf(s),requestId:randomUUID(),reservationId:s.reservation.id,
          betDigest:s.digest,outcomeHash:s.reservation.outcomeHash,extendSeconds:60}));validateHeader(s,response);
        if(response.success!==true||response.reservationId!==s.reservation.id||Number(response.expiresAt)<s.reservation.expiresAt)
          throw fail('Renewal response mismatch','FINANCE_RESPONSE_INVALID');
        s.reservation.expiresAt=Number(response.expiresAt);
      });
    },
  });
}
