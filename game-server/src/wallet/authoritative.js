import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { captureGameState } from './transaction-state.js';
import {MAX_CASH_ACCOUNTS,MAX_CASH_STEPS} from '../../../shared/cash-limits.js';

const ownerKey = Symbol.for('gogame.authoritative.cash');
const memberKey = Symbol.for('gogame.cash.carry.member');
const TTL = 300000, RENEW = 60000;
const netSeatTypes=new Set([24,26,27,28,30]);
const identity = s => JSON.stringify([Number(s.agentId),Number(s.userId),s.currency || 'CNY']);
const accountOf = s => ({ agentId:Number(s.agentId),userId:Number(s.userId),currency:s.currency || 'CNY' });
const tableKey = t => `${Number(t.agentId)}:${t.gameId}:${Number(t.roomId)}`;
const fail = message => Object.assign(new Error(message),{code:'CARRY_CONFLICT',status:409});
const validMoney = n => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid wallet amount'); };
const uncertainCommit = error => ![3,5,7,8,9,12,16].includes(Number(error?.code))
  && ([1,2,4,13,14].includes(Number(error?.code))||[502,503,504].includes(error?.status)
    ||['ECONNRESET','ETIMEDOUT','EPIPE'].includes(error?.code));

export function createAuthoritativeWallet(rpc) {
  const state = rpc.common[ownerKey] ||= { context:new AsyncLocalStorage(),accounts:new Map(),members:new Set(),tail:Promise.resolve() };
  // Safety state only, not a journal or a pending-payment/replay mechanism.
  // A successful balance read cannot prove which timed-out command committed.
  state.unconfirmedAccounts ||= new Set();
  state.readSerial ??= 0;
  const assertConfirmed=session=>{if(state.unconfirmedAccounts.has(identity(session)))
    throw Object.assign(new Error('资金提交结果待核验，已暂停该账户资金操作，请联系管理员'),{code:'CASH_CONFIRMATION_REQUIRED',status:503});};
  function retainedSessions(table){
    const list=[...(table.playerSessions?.values()||[])];
    const participants=[...(table.members||[]),...(table.hand?.participants||[]),...(table.hand?.statsPlayers||[])].map(p=>p.member||p);
    for(const member of participants)if(member[memberKey])list.push(member[memberKey].session);
    for(const member of state.members)if(member[memberKey]?.table===table)list.push(member[memberKey].session);
    for(const bankers of [table.hundredBankers,table.casinoBankers]){
      for(const entry of bankers?.entries||[])list.push(entry.session);
      for(const refund of bankers?.refunds||[])list.push(refund.session||refund.e?.session);
    }
    return list.filter(s=>s&&!s.bot&&s.userId&&s.agentId);
  }
  function tx() { const t=state.context.getStore(); return t && !t.closed ? t : null; }
  function markAccount(t,session){const key=identity(session);if(!t.keys.has(key))t.keys.set(key,t.keys.size+1);return key;}
  function queueFinance(action){const t=tx();t.financeActions.push(action);t.ordered.push({action});}
  function withFinalReports(table,items){
    const reports=tx()?.finalReports?.get(table);if(!reports)return items;
    return items.map(item=>{
      const report=reports.get(Number(item.session.userId));if(!report)return item;
      const original=item.record&&typeof item.record==='object'&&!Array.isArray(item.record)?item.record:{gameResult:item.record??null};
      return {...item,record:{...original,completedDisplayReport:report}};
    });
  }
  function requireTransaction() { if(!tx())throw Object.assign(new Error('Authoritative money requires a managed game transaction'),{code:'WALLET_UNAVAILABLE'}); }
  function view(session) {
    const key=identity(session), t=tx(), stored=state.accounts.get(key);
    if (!stored) throw new Error('Load authoritative cash account before use');
    if (!t) return stored;
    if (!t.accounts.has(key)) t.accounts.set(key,{...stored,carry:stored.carry ? {...stored.carry} : null});
    return t.accounts.get(key);
  }
  function accountObservation(account,result,startedAt,serial) {
    if (!Number.isSafeInteger(result.balance) || result.balance<0) throw new Error('Invalid authoritative wallet balance');
    const carry=result.carry;
    if(carry!=null&&(!Number.isSafeInteger(carry.amount)||carry.amount<0||carry.amount>result.balance
      ||!Number.isSafeInteger(carry.revision)||carry.revision<0||typeof carry.token!=='string'||!carry.token
      ||typeof carry.tableKey!=='string'||!carry.tableKey||!Number.isSafeInteger(result.ttlMs)||result.ttlMs<0))
      throw new Error('Invalid authoritative carry lease');
    const value={...account,revision:result.revision,balance:result.balance,carry:result.carry || null,expiresAt:result.carry ? startedAt+result.ttlMs : 0,observedRead:serial};
    if (!Number.isSafeInteger(value.revision) || value.revision<0) throw new Error('Invalid authoritative cash revision');
    return value;
  }
  function cacheObservation(value,committed=false) {
    const key=identity(value),serial=value.observedRead;
    const current=state.accounts.get(key);
    // A reply cannot undo a later confirmed commit or a newer read of the
    // same revision (including an already-expired carry lease).
    // A commit acknowledgement is a snapshot taken before its reply arrives.
    // A read already observing that revision can also know its lease expired.
    if(current&&(value.revision<current.revision||value.revision===current.revision&&(committed||(current.observedRead||0)>serial)))return current;
    if(current&&value.revision===current.revision&&value.carry&&current.carry
      &&value.carry.token===current.carry.token&&value.carry.tableKey===current.carry.tableKey)
      value.expiresAt=Math.min(value.expiresAt,current.expiresAt);
    state.accounts.set(key,value);
    return value;
  }
  async function read(session) {
    const account=accountOf(session),key=identity(session),startedAt=Date.now(),serial=++state.readSerial;
    const result=await rpc.common.cashRead(account);
    if(identity(session)!==key)throw fail('资金查询账户已变化，请重新加载钱包');
    return cacheObservation(accountObservation(account,result,startedAt,serial));
  }
  function attach(session) {
    Object.defineProperties(session,{
      wallet:{configurable:true,enumerable:true,get:()=>view(session).balance,set:value=>{if(value!==view(session).balance)throw new Error('Balance snapshots cannot mutate authoritative money');}},
      carryAmount:{configurable:true,enumerable:true,get:()=>view(session).carry?.amount || 0},
      availableBalance:{configurable:true,enumerable:true,get:()=>view(session).balance-(view(session).carry?.amount || 0)},
    });
  }
  function stage(session,kind,amount,options={}) {
    assertConfirmed(session);
    const t=tx();if(!t)throw Object.assign(new Error('Authoritative money requires a managed game transaction'),{code:'WALLET_UNAVAILABLE'});
    const value=view(session), key=identity(session);
    if(state.finance&&['debit','credit','carryDelta'].includes(kind)
      &&(!options.financeTable||wallet.lotteryFor(options.financeTable)))t.unsupportedFinance=true;
    if(t.steps.length>=MAX_CASH_STEPS||!t.keys.has(key)&&t.keys.size>=MAX_CASH_ACCOUNTS)
      throw Object.assign(new Error('资金事务容量超限，未提交本批操作'),{code:'CASH_CAPACITY_EXCEEDED',status:413});
    if(!t.keys.has(key))t.keys.set(key,t.keys.size+1);
    const step={id:'op-'+randomUUID(),account:t.keys.get(key),kind,amount,...options.fields};
    t.steps.push(step);t.ordered.push({step});return value;
  }
  function lease(member,strict=true) {
    const binding=member?.[memberKey];if(!binding)return null;
    const value=view(binding.session), carry=value.carry;
    if(binding.released)return null;
    if(!carry || carry.token!==binding.token || value.expiresAt<=Date.now()){if(!strict)return null;throw fail('带入凭证已过期，请重新入座');}
    return {binding,value,carry};
  }
  function fields(binding,carry) {return {token:binding.token,tableKey:binding.tableKey,revision:carry.revision};}
  function bind(session,member,table,token) {
    const binding={...member[memberKey],session,table,tableKey:tableKey(table),token};
    Object.defineProperty(member,memberKey,{value:binding,configurable:true});
    state.members.add(member);
    Object.defineProperty(member,'point',{configurable:true,enumerable:true,get:()=>{
      const l=lease(member,false);if(!l)return 0;
      const book=binding.netHand?.lotterySeatBooks?.get(Number(member.uid));return book?.netActive?book.point:l.carry.amount;
    },set:value=>{
      validMoney(value);const l=lease(member);if(!l){if(value===0)return;throw fail('座位已带出');}
      const shadow=binding.netHand?.lotterySeatBooks?.get(Number(member.uid));
      const delta=value-(shadow?.netActive?shadow.point:l.carry.amount);if(!delta)return;
      if(wallet.lotteryFor(table)&&netSeatTypes.has(Number(table.roomType))){
        if(!shadow?.netActive)throw fail('A registered seat hand is required for net transfers');
        assertConfirmed(session);shadow.point=value;return;
      }
      if(l.value.balance+delta<0 || !Number.isSafeInteger(l.value.balance+delta))throw fail('余额不足');
      if(wallet.lotteryFor(table)&&[19,25,31,32].includes(Number(table.roomType))){
        const hand=table.hand;if(!hand)throw fail('A live financial hand is required for seat chip changes');
        const book=seatBook(hand,member,session),t=tx();assertConfirmed(session);markAccount(t,session);
        if(delta<0){
          if(book.payout)throw fail('Seat payouts cannot be wagered before settlement');
          const carry={token:l.carry.token,tableKey:l.carry.tableKey,revision:l.carry.revision},operation={};
          queueFinance(()=>state.finance.bet(table,hand,session,[{areaId:'seat',amount:-delta}],operation,carry));
          book.bet-=delta;l.carry.revision++;
        }else{
          if(!book.payout){book.creditCarry={token:l.carry.token,tableKey:l.carry.tableKey,revision:l.carry.revision};l.carry.revision++;}
          book.payout+=delta;t.financeCredits=true;
        }
        l.value.balance+=delta;l.carry.amount=value;l.value.expiresAt=Date.now()+TTL;return;
      }
      stage(session,'carryDelta',delta,{fields:fields(binding,l.carry),financeTable:table});
      l.value.balance+=delta;l.carry.amount=value;l.carry.revision++;l.value.expiresAt=Date.now()+TTL;
    }});
    member.carryMode='reservation';return binding;
  }
  function seatBook(hand,member,session){
    hand.lotterySeatBooks ||= new Map();
    if(!hand.lotterySeatBooks.has(Number(member.uid)))hand.lotterySeatBooks.set(Number(member.uid),{member,session,bet:0,payout:0,point:member.point,opening:member.point});
    return hand.lotterySeatBooks.get(Number(member.uid));
  }
  function installSeatFinance(table){
    table.beginSeatFinance=(hand,players)=>{
      if(Number(table.roomType)===31&&table.playMode===1)return;
      if(!wallet.lotteryFor(table)||![19,24,25,26,27,28,30,31,32].includes(Number(table.roomType)))return;
      state.finance.identity(table,hand);
      for(const player of players){
        const member=player.member||player,binding=member[memberKey];if(!binding)continue;
        const book=seatBook(hand,member,binding.session);
        if(netSeatTypes.has(Number(table.roomType))&&!book.registered){
          book.registered=true;book.netActive=true;binding.netHand=hand;
          const l=lease(member),carry={token:l.carry.token,tableKey:l.carry.tableKey,revision:l.carry.revision},operation={};
          markAccount(tx(),binding.session);
          queueFinance(()=>state.finance.bet(table,hand,binding.session,[{areaId:'seat-participant',amount:0}],operation,carry));
        }
      }
    };
    table.finishSeatFinance=(hand,results,publicResult)=>{
      if(Number(table.roomType)===31&&table.playMode===1)return;
      if(!wallet.lotteryFor(table)||![19,24,25,26,27,28,30,31,32].includes(Number(table.roomType)))return;
      const financial=[];
      if(netSeatTypes.has(Number(table.roomType))){
        const t=tx();t.financeSettlement=true;
        for(const result of results){
          const book=hand.lotterySeatBooks?.get(Number(result.uid));if(!book)continue;
          const score=Number(result.score),l=lease(book.member);
          if(!Number.isSafeInteger(score)||book.point-book.opening!==score)throw fail('Seat net result does not match room chips');
          const carry={token:l.carry.token,tableKey:l.carry.tableKey,revision:l.carry.revision};
          if(l.value.balance+score<0||!Number.isSafeInteger(l.value.balance+score)||l.carry.amount+score<0)throw fail('Seat net transfer exceeds funded liability');
          l.value.balance+=score;l.carry.amount+=score;l.carry.revision++;l.value.expiresAt=Date.now()+TTL;book.netActive=false;
          assertConfirmed(book.session);markAccount(t,book.session);
          financial.push({session:book.session,score,pump:Number(result.take||result.tax||0),carry,record:JSON.parse(JSON.stringify(result))});
        }
        const outcome={roomId:table.roomId,inning:table.currentInning,results:JSON.parse(JSON.stringify(results))};
        queueFinance(()=>state.finance.settleNet(table,hand,withFinalReports(table,financial),outcome));return;
      }
      for(const result of results){
        const book=hand.lotterySeatBooks?.get(Number(result.uid));if(!book)continue;
        if(!book.bet&&!book.payout)continue;
        if(!book.bet&&book.payout)throw fail('A seat payout has no accepted wagers');
        if(Number(result.xiaZhuData)!==book.bet||Number(result.score)!==book.payout-book.bet)throw fail('Seat settlement does not match actual wager and payout');
        const l=lease(book.member),carry=book.creditCarry||{token:l.carry.token,tableKey:l.carry.tableKey,revision:l.carry.revision};
        financial.push({session:book.session,payout:book.payout,pump:Number(result.tax||0),carry,
          record:JSON.parse(JSON.stringify(result))});
      }
      wallet.settleLottery(table,hand,financial,{roomId:table.roomId,inning:table.currentInning,
        results:JSON.parse(JSON.stringify(results)),publicResult:publicResult==null?null:JSON.parse(JSON.stringify(publicResult))});
    };
  }
  function deliverCommitted(t){
    t.closed=true;
    const failed=error=>{
      // Notification failure is not financial uncertainty. Even a broken
      // logger must not send a confirmed transaction through game rollback.
      try{t.log?.error?.('confirmed game action notification failed',error?.message||String(error));}catch{}
    };
    const deliveries=t.deliveries.splice(0);
    for(const deliver of deliveries){
      try{const sent=deliver();if(sent&&typeof sent.then==='function')Promise.resolve(sent).catch(failed);}
      catch(error){failed(error);}
    }
  }
  function publish(result,t,startedAt,serial) {
    const invalid=()=>{throw Object.assign(new Error('Authoritative cash commit response is incomplete or inconsistent'),
      {code:'CASH_COMMIT_RESPONSE_INVALID',status:503});};
    if(!Array.isArray(result?.accounts)||result.accounts.length!==t.request.accounts.length)invalid();
    const expected=new Map(t.request.accounts.map(a=>[identity(a),a])),seen=new Set();
    for(const account of result.accounts){
      const key=identity(account),before=expected.get(key),draft=t.accounts.get(key);
      if(!before||seen.has(key)||!Number.isSafeInteger(account.balance)||account.balance<0
        ||account.balance!==draft.balance||!Number.isSafeInteger(account.revision)||account.revision!==before.revision+1)invalid();
      const carry=account.carry;
      if(Boolean(carry)!==Boolean(draft.carry)||carry&&['amount','revision','token','tableKey'].some(field=>carry[field]!==draft.carry[field]))invalid();
      if(carry!=null&&(!Number.isSafeInteger(carry.amount)||carry.amount<0||carry.amount>account.balance
        ||!Number.isSafeInteger(carry.revision)||carry.revision<0||typeof carry.token!=='string'||!carry.token
        ||typeof carry.tableKey!=='string'||!carry.tableKey||!Number.isSafeInteger(account.ttlMs)||account.ttlMs<=0))invalid();
      seen.add(key);
    }
    for (const a of result.accounts) cacheObservation(accountObservation(accountOf(a),a,startedAt,serial),true);
    deliverCommitted(t);
  }
  async function commit(t) {
    if(t.financeActions.length){
      if(t.steps.some(step=>!['reserve','renew','release'].includes(step.kind)))throw Object.assign(new Error('Cannot mix cash mutations with Lottery in one game action'),{code:'FINANCE_MIXED_TRANSACTION',status:409});
      let wrote=false,cashWritten=false;
      try{
        for(const operation of t.ordered){
          if(operation.step){
            const step=operation.step,original=t.request.accounts[step.account-1],actual=await rpc.common.cashRead(original);
            wrote=true;cashWritten=true;
            const result=await rpc.common.cashApply({id:'carry-'+randomUUID(),accounts:[{...accountOf(original),revision:actual.revision}],steps:[{...step,account:1}]});
            if(!Array.isArray(result?.accounts)||result.accounts.length!==1)throw Object.assign(new Error('Carry mutation response is incomplete'),{status:503});
            continue;
          }
          wrote=true;
          const receipt=await operation.action();
          if(receipt?.ok===false)throw Object.assign(new Error('Lottery rejected wager'),{code:'FINANCE_WAGER_REJECTED',status:409});
        }
        const accounts=[];
        for(const [key,draft]of t.accounts){
          const startedAt=Date.now(),serial=++state.readSerial;
          const actual=await rpc.common.cashRead(accountOf(draft));
          if(actual.balance!==draft.balance||Boolean(actual.carry)!==Boolean(draft.carry)
            ||actual.carry&&['amount','revision','token','tableKey'].some(field=>actual.carry[field]!==draft.carry[field])
            ||!Number.isSafeInteger(actual.revision)||actual.revision<0)
            throw Object.assign(new Error('Lottery balance disagrees with staged game action'),{code:'FINANCE_BALANCE_MISMATCH',status:503});
          accounts.push(accountObservation(accountOf(draft),actual,startedAt,serial));
        }
        for(const a of accounts)cacheObservation(a);
        deliverCommitted(t);return;
      }catch(error){
        if(wrote&&(cashWritten||error.code!=='FINANCE_WAGER_REJECTED'))error.uncertain=true;
        throw error;
      }
    }
    const startedAt=Date.now(),serial=++state.readSerial;
    const result=await rpc.common.cashApply(t.request);publish(result,t,startedAt,serial);
  }
  async function execute(action,runtime) {
    const attached=new Map();
    const include=s=>{if(s&&!s.bot&&s.userId&&s.agentId)attached.set(identity(s),s);};
    for(const s of runtime.registry.sessions.values())if(s.authenticated!==false)include(s);
    for(const member of state.members)include(member[memberKey]?.session);
    for(const table of runtime.registry.tables.values())for(const s of retainedSessions(table))include(s);
    await Promise.all([...attached.values()].filter(s=>!state.unconfirmedAccounts.has(identity(s))).map(read));
    const boundBefore=[...state.members], restoreEngine=captureGameState(runtime,[state,...state.accounts.values()]);
    const restore=()=>{restoreEngine();state.members.clear();for(const m of boundBefore)state.members.add(m);};
    const t={accounts:new Map(),keys:new Map(),steps:[],ordered:[],financeActions:[],financeCredits:false,financeSettlement:false,deliveries:[],closed:false,log:runtime.log};
    return state.context.run(t,async()=>{
      try{
      let result;
      try {result=await action();}
      catch(error){t.closed=true;restore();throw error;}
      if(t.financeCredits&&!t.financeSettlement){t.closed=true;restore();throw Object.assign(new Error('Lottery payout has no complete settlement'),{code:'FINANCE_SETTLEMENT_MISSING',status:409});}
      if(!t.steps.length&&!t.financeActions.length){deliverCommitted(t);return result;}
      if(t.unsupportedFinance){
        t.closed=true;restore();throw Object.assign(new Error('This monetary action has no Lottery adapter'),{code:'FINANCE_ACTION_UNSUPPORTED',status:503});
      }
      // Submit against the exact revision used to calculate the staged action.
      // An unrelated refresh cannot upgrade this transaction's concurrency token.
      t.request={id:'tx-'+randomUUID(),accounts:[...t.keys.keys()].map(k=>({...accountOf(t.accounts.get(k)),revision:t.accounts.get(k).revision})),steps:t.steps};
      try {await commit(t);}
      catch(error){
        t.closed=true;
        restore();
        if(error.uncertain||uncertainCommit(error)){
          for(const key of t.keys.keys())state.unconfirmedAccounts.add(key);
          error.cashTransactionId=t.request.id;
          runtime.log?.error?.('cash commit confirmation lost; affected accounts paused',t.request.id);
        }
        throw error;
      }
      return result;
      }finally{
        t.closed=true;
        restoreEngine.discard?.();boundBefore.length=0;attached.clear();
      }
    });
  }
  const wallet={
    mode:'online',carryEnabled:true,authoritative:true,
    guardExternalMoney(session){assertConfirmed(session);if(tx())throw new Error('External ticket authority cannot run inside a staged cash transaction');},
    get lottery(){return state.finance;},
    get bankerNetEnabled(){return state.bankerNetEnabled===true;},
    lotteryFor(table){return state.finance&&state.financeTypes.has(Number(table?.roomType))?state.finance:null;},
    configureLottery(finance,roomTypes=[50,51,52,53,54,55,56,57,58,59,60,62],runtime){
      if(runtime?.config?.finance?.banker_net===true)state.bankerNetEnabled=true;
      if(state.finance&&finance===null)throw new Error('Cannot remove active Lottery integration through hot update');
      if(!Array.isArray(roomTypes)||roomTypes.some(type=>![19,24,25,26,27,28,30,31,32,50,51,52,53,54,55,56,57,58,59,60,62].includes(type)))
        throw new Error('Lottery rollout contains an unsupported room type');
      if(state.finance&&JSON.stringify([...state.financeTypes].sort())!==JSON.stringify([...new Set(roomTypes)].sort()))
        throw new Error('Cannot switch financial providers on active room types through hot update');
      if(!state.finance&&runtime){
        for(const table of runtime.registry.tables.values())if(roomTypes.includes(Number(table.roomType))){
          if(table.hundredSettledInning!==table.inning&&[...(table.playerBets?.values()||[])].some(bets=>bets.length)
            ||table.hundredBankers?.entries?.some(entry=>entry.onBanker)||table.casinoBankers?.entries?.some(entry=>entry.onBanker)||table.kind==='normal'&&table.hand
            ||table.hundredBankers?.refunds?.length||table.casinoBankers?.refunds?.length||table.casinoBankers?.entries?.some(entry=>entry.dirty)
            ||table.casinoWalletDirty?.size||table.casinoWalletTask
            ||table.roomType===31&&table.playMode===1&&table.members.some(m=>!m.bot&&m.point>0))throw new Error('Finish existing cash-funded rounds and banker escrows before switching to Lottery');
        }
      }
      state.finance=finance;
      state.financeTypes=new Set(roomTypes);
      for(const member of state.members){const b=member[memberKey];if(b){bind(b.session,member,b.table,b.token);installSeatFinance(b.table);}}
    },
    settleLottery(table,round,results,outcome){
      requireTransaction();const t=tx(),controller=state.finance;if(!controller)throw new Error('Lottery controller is unavailable');
      t.financeSettlement=true;
      for(const item of results){assertConfirmed(item.session);view(item.session);markAccount(t,item.session);}
      queueFinance(()=>controller.settle(table,round,withFinalReports(table,results),outcome));
    },
    stageFinalReports(table,reports){
      const t=tx();if(!t||!this.lotteryFor(table)||!t.financeSettlement)return false;
      t.finalReports||=new Map();const records=t.finalReports.get(table)||new Map();
      for(const record of reports){
        if(Number(record.agentId)!==Number(table.agentId)||record.replayOnly)continue;
        const snapshot=JSON.parse(JSON.stringify(record));
        if(Buffer.byteLength(JSON.stringify(snapshot))>256000)throw Object.assign(new Error('Final display report exceeds settlement storage limit'),{status:413});
        records.set(Number(record.userId),snapshot);
      }
      t.finalReports.set(table,records);return true;
    },
    registerBanker(table,round,session,member,cap){
      requireTransaction();validMoney(cap);const value=view(session);assertConfirmed(session);markAccount(tx(),session);
      if(!member||!value.carry||cap>value.carry.amount)throw fail('Banker collateral is not funded');
      round.bankerAccounts||=new Map();if(round.bankerAccounts.has(session.userId))return;
      const carry={token:value.carry.token,tableKey:value.carry.tableKey,revision:value.carry.revision};
      round.bankerAccounts.set(session.userId,{cap});
      queueFinance(()=>state.finance.bet(table,round,session,[{areaId:'banker:'+cap,amount:0}],{},carry));
    },
    bankerResult(table,item,apply){
      const {session,score,member,cap}=item,value=view(session);validMoney(Math.abs(score));assertConfirmed(session);
      const carry=value.carry;
      if(!member||!carry||Math.abs(score)>cap||carry.amount+score<0||value.balance+score<0||!Number.isSafeInteger(value.balance+score)||!Number.isSafeInteger(carry.amount+score))throw fail('Banker result exceeds funded liability');
      const binding={token:carry.token,tableKey:carry.tableKey,revision:carry.revision};
      if(apply){markAccount(tx(),session);value.balance+=score;carry.amount+=score;carry.revision++;}
      return {session,netScore:score,payout:Math.abs(score)+score,carry:binding,record:{roomId:table.roomId,inning:table.inning??table.currentInning,banker:true,score,cap}};
    },
    reserveLottery(table,round,results,outcome){
      requireTransaction();const t=tx();
      for(const item of results){assertConfirmed(item.session);view(item.session);markAccount(t,item.session);}
      queueFinance(()=>state.finance.reserve(table,round,results,outcome));
    },
    renewLottery(table){
      const controller=this.lotteryFor(table),round=table.lotteryRound;
      if(!controller||!round)return;
      requireTransaction();const t=tx();
      for(const [uid,bets]of table.playerBets||[]){
        const session=table.playerSessions?.get(uid);
        if(session&&!session.bot&&bets.length){view(session);markAccount(t,session);}
      }
      queueFinance(()=>controller.renew(table,round));
    },
    managed(){return Boolean(tx());},
    run(action,runtime){
      if(tx())return Promise.resolve().then(action);
      const task=state.tail.catch(()=>{}).then(()=>execute(action,runtime));state.tail=task;return task;
    },
    deliver(send){const t=tx();if(t)t.deliveries.push(send);else send();},
    async load(session){const key=identity(session);await read(session);if(identity(session)!==key)throw fail('资金查询账户已变化，请重新加载钱包');attach(session);return session;},
    async refreshCarry(session){if(!tx())await read(session);return this.carryRecord(session);},
    carryRecord(session){const value=view(session);return value.carry ? {...value.carry,expiresAt:value.expiresAt} : null;},
    available(session){const a=view(session);return a.balance-(a.carry?.amount || 0);},
    assertCashEntry(session,table){const c=view(session).carry;if(c && c.tableKey!==tableKey(table))throw fail('当前仍有其他棋牌桌带入，请先离座');return c;},
    async checkCashEntry(session,table){if(!tx())await read(session);return this.assertCashEntry(session,table);},
    reserveCarry(session,member,table,amount){
      requireTransaction();validMoney(amount);const value=view(session);this.assertCashEntry(session,table);
      const old=member[memberKey];
      if(value.carry && (!old || old.token!==value.carry.token))throw fail('已有带入，请恢复原座位');
      if(amount>this.available(session))return {ok:false,balance:value.balance};
      const token=value.carry?.token || randomUUID();
      stage(session,'reserve',amount,{fields:{token,tableKey:tableKey(table)}});
      if(!value.carry)value.carry={token,tableKey:tableKey(table),amount:0,revision:0};
      value.carry.amount+=amount;value.carry.revision++;value.expiresAt=Date.now()+TTL;
      const shadow=old?.netHand?.lotterySeatBooks?.get(Number(member.uid));
      if(shadow?.netActive){shadow.opening+=amount;shadow.point+=amount;}
      if(!old||old.released)bind(session,member,table,token);installSeatFinance(table);return {ok:true,balance:value.balance,carry:value.carry.amount};
    },
    releaseCarry(session,member,amount=member?.point || 0,keepOwner=false){
      const l=lease(member,false);
      if(!l){
        const binding=member?.[memberKey];
        if(binding){binding.released=true;state.members.delete(member);}
        return Boolean(binding);
      }
      validMoney(amount);if(amount>l.carry.amount)throw fail('带出超过带入值');
      stage(l.binding.session,'release',amount,{fields:{...fields(l.binding,l.carry),keepOwner}});
      l.carry.amount-=amount;l.carry.revision++;l.value.expiresAt=Date.now()+TTL;
      if(!l.carry.amount && !keepOwner){l.value.carry=null;l.binding.released=true;state.members.delete(member);}
      if(keepOwner)l.binding.pendingDeparture=true;return true;
    },
    renewCarry(member){
      const l=lease(member);if(!l)return;
      if(l.value.expiresAt-Date.now()>TTL-RENEW)return;
      stage(l.binding.session,'renew',0,{fields:fields(l.binding,l.carry)});l.value.expiresAt=Date.now()+TTL;
    },
    guardCashTable(table){
      this.renewLottery(table);
      const responsible=new Set([...(table.members||[]),...(table.hand?.participants||[]),...(table.hand?.statsPlayers||[])]
        .map(p=>Number(p.uid??p.member?.uid)));
      for(const [uid,bets]of table.playerBets||[])if(bets.length)responsible.add(Number(uid));
      for(const bankers of [table.hundredBankers,table.casinoBankers]){
        for(const e of bankers?.entries||[])responsible.add(Number(e.uid));
        for(const r of bankers?.refunds||[])responsible.add(Number((r.session||r.e?.session)?.userId));
      }
      for(const s of retainedSessions(table))if(responsible.has(Number(s.userId)))assertConfirmed(s);
      const members=new Set([...(table.members || []),...(table.hand?.participants || []),...(table.hand?.statsPlayers || []).map(p=>p.member || p)]);
      for(const m of members)if(m[memberKey])this.renewCarry(m);
    },
    releaseFinishedCarries(table){
      if(table.hand || table.phase==='playing')return;
      for(const member of [...state.members]){const b=member[memberKey];if(b?.table===table && b.pendingDeparture)this.releaseCarry(b.session,member);}
    },
    debit(session,amount,meta){
      requireTransaction();validMoney(amount);const v=view(session);if(amount>this.available(session))return {ok:false,balance:v.balance};
      if(state.finance&&meta?.finance?.kind==='bet'){
        assertConfirmed(session);const t=tx(),{table,round,bets}=meta.finance;
        if(bets.reduce((sum,b)=>sum+b.amount,0)!==amount)throw new Error('Financial wager amount mismatch');
        markAccount(t,session);
        const operation={};queueFinance(()=>state.finance.bet(table,round,session,bets,operation));
      }else stage(session,'debit',amount,{meta,financeTable:meta?.table});
      v.balance-=amount;return {ok:true,balance:v.balance};
    },
    credit(session,amount,meta){
      requireTransaction();validMoney(amount);const v=view(session);if(!Number.isSafeInteger(v.balance+amount))throw new Error('Invalid wallet balance');
      if(state.finance&&meta?.finance){
        assertConfirmed(session);const t=tx(),{kind,table,round}=meta.finance;markAccount(t,session);
        if(kind==='cancel'){
          const operation={};queueFinance(async()=>{const receipt=await state.finance.cancel(table,round,session,operation);
            if(receipt.refund!==amount)throw Object.assign(new Error('Financial cancellation refund mismatch'),{status:503});return receipt;});
        }else if(kind==='payout')t.financeCredits=true;
        else throw new Error('Unknown financial credit');
      }else stage(session,'credit',amount,{meta,financeTable:meta?.table});
      v.balance+=amount;return {ok:true,balance:v.balance};
    },
    async persist(){},
  };
  return wallet;
}
