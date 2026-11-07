import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { captureGameState } from './transaction-state.js';

const ownerKey = Symbol.for('gogame.authoritative.cash');
const memberKey = Symbol.for('gogame.cash.carry.member');
const TTL = 300000, RENEW = 60000;
const identity = s => JSON.stringify([Number(s.agentId),Number(s.userId),s.currency || 'CNY']);
const accountOf = s => ({ agentId:Number(s.agentId),userId:Number(s.userId),currency:s.currency || 'CNY' });
const tableKey = t => `${Number(t.agentId)}:${t.gameId}:${Number(t.roomId)}`;
const fail = message => Object.assign(new Error(message),{code:'CARRY_CONFLICT',status:409});
const validMoney = n => { if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid wallet amount'); };

export function createAuthoritativeWallet(rpc) {
  const state = rpc.common[ownerKey] ||= { context:new AsyncLocalStorage(),accounts:new Map(),members:new Set(),tail:Promise.resolve() };
  function tx() { const t=state.context.getStore(); return t && !t.closed ? t : null; }
  function requireTransaction() { if(!tx())throw Object.assign(new Error('Authoritative money requires a managed game transaction'),{code:'WALLET_UNAVAILABLE'}); }
  function view(session) {
    const key=identity(session), t=tx(), stored=state.accounts.get(key);
    if (!stored) throw new Error('Load authoritative cash account before use');
    if (!t) return stored;
    if (!t.accounts.has(key)) t.accounts.set(key,{...stored,carry:stored.carry ? {...stored.carry} : null});
    return t.accounts.get(key);
  }
  async function read(session) {
    const result=await rpc.common.cashRead(accountOf(session));
    if (!Number.isSafeInteger(result.balance) || result.balance<0) throw new Error('Invalid authoritative wallet balance');
    const value={...accountOf(session),revision:result.revision,balance:result.balance,carry:result.carry || null,expiresAt:result.carry ? Date.now()+result.ttlMs : 0};
    if (!Number.isSafeInteger(value.revision) || value.revision<0) throw new Error('Invalid authoritative cash revision');
    state.accounts.set(identity(session),value);
    return value;
  }
  function attach(session) {
    Object.defineProperties(session,{
      wallet:{configurable:true,enumerable:true,get:()=>view(session).balance,set:value=>{if(value!==view(session).balance)throw new Error('Balance snapshots cannot mutate authoritative money');}},
      carryAmount:{configurable:true,enumerable:true,get:()=>view(session).carry?.amount || 0},
      availableBalance:{configurable:true,enumerable:true,get:()=>view(session).balance-(view(session).carry?.amount || 0)},
    });
  }
  function stage(session,kind,amount,options={}) {
    const t=tx();if(!t)throw Object.assign(new Error('Authoritative money requires a managed game transaction'),{code:'WALLET_UNAVAILABLE'});
    const value=view(session), key=identity(session);
    if(!t.keys.has(key))t.keys.set(key,t.keys.size+1);
    const step={id:'op-'+randomUUID(),account:t.keys.get(key),kind,amount,...options.fields};
    t.steps.push(step);return value;
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
    const binding={session,table,tableKey:tableKey(table),token};
    Object.defineProperty(member,memberKey,{value:binding,configurable:true});
    state.members.add(member);
    Object.defineProperty(member,'point',{configurable:true,enumerable:true,get:()=>{const l=lease(member,false);return l?.carry.amount || 0;},set:value=>{
      validMoney(value);const l=lease(member);if(!l){if(value===0)return;throw fail('座位已带出');}
      const delta=value-l.carry.amount;if(!delta)return;
      if(l.value.balance+delta<0 || !Number.isSafeInteger(l.value.balance+delta))throw fail('余额不足');
      stage(session,'carryDelta',delta,{fields:fields(binding,l.carry)});
      l.value.balance+=delta;l.carry.amount=value;l.carry.revision++;l.value.expiresAt=Date.now()+TTL;
    }});
    member.carryMode='reservation';return binding;
  }
  function publish(result,t) {
    for (const a of result.accounts || []) state.accounts.set(identity(a),{...a,expiresAt:a.carry ? Date.now()+a.ttlMs : 0});
    t.closed=true;
    for(const deliver of t.deliveries)deliver();
  }
  async function commit(t) {
    const result=await rpc.common.cashApply(t.request);publish(result,t);
  }
  async function execute(action,runtime) {
    const attached=new Map();
    for(const s of runtime.registry.sessions.values())if(s.authenticated!==false && s.userId && s.agentId)attached.set(identity(s),s);
    for(const table of runtime.registry.tables.values())for(const m of table.members || [])if(m[memberKey])attached.set(identity(m[memberKey].session),m[memberKey].session);
    await Promise.all([...attached.values()].map(read));
    const boundBefore=[...state.members], restoreEngine=captureGameState(runtime,[state,...state.accounts.values()]);
    const restore=()=>{restoreEngine();state.members.clear();for(const m of boundBefore)state.members.add(m);};
    const t={accounts:new Map(),keys:new Map(),steps:[],deliveries:[],closed:false};
    return state.context.run(t,async()=>{
      let result;
      try {result=await action();}
      catch(error){t.closed=true;restore();throw error;}
      if(!t.steps.length){t.closed=true;for(const deliver of t.deliveries)deliver();return result;}
      t.request={id:'tx-'+randomUUID(),accounts:[...t.keys.keys()].map(k=>({...accountOf(t.accounts.get(k)),revision:state.accounts.get(k).revision})),steps:t.steps};
      try {await commit(t);}
      catch(error){
        t.closed=true;
        restore();
        throw error;
      }
      return result;
    });
  }
  const wallet={
    mode:'online',carryEnabled:true,authoritative:true,
    managed(){return Boolean(tx());},
    run(action,runtime){
      if(tx())return Promise.resolve().then(action);
      const task=state.tail.catch(()=>{}).then(()=>execute(action,runtime));state.tail=task;return task;
    },
    deliver(send){const t=tx();if(t)t.deliveries.push(send);else send();},
    async load(session){await read(session);attach(session);return session;},
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
      if(!old)bind(session,member,table,token);return {ok:true,balance:value.balance,carry:value.carry.amount};
    },
    releaseCarry(session,member,amount=member?.point || 0,keepOwner=false){
      const l=lease(member,false);if(!l)return Boolean(member?.[memberKey]);
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
      const members=new Set([...(table.members || []),...(table.hand?.participants || []),...(table.hand?.statsPlayers || []).map(p=>p.member || p)]);
      for(const m of members)if(m[memberKey])this.renewCarry(m);
    },
    releaseFinishedCarries(table){
      if(table.hand || table.phase==='playing')return;
      for(const member of [...state.members]){const b=member[memberKey];if(b?.table===table && b.pendingDeparture)this.releaseCarry(b.session,member);}
    },
    debit(session,amount,meta){requireTransaction();validMoney(amount);const v=view(session);if(amount>this.available(session))return {ok:false,balance:v.balance};stage(session,'debit',amount,{meta});v.balance-=amount;return {ok:true,balance:v.balance};},
    credit(session,amount,meta){requireTransaction();validMoney(amount);const v=view(session);if(!Number.isSafeInteger(v.balance+amount))throw new Error('Invalid wallet balance');stage(session,'credit',amount,{meta});v.balance+=amount;return {ok:true,balance:v.balance};},
    async persist(){},
  };
  return wallet;
}
