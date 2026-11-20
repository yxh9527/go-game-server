import assert from 'node:assert/strict';
import {moneyToScore,scoreToMoney} from '../../game-server/src/wallet/round-finance.js';
export const signedFinanceScore=value=>value.startsWith('-')?-moneyToScore(value.slice(1)):moneyToScore(value);

// Isolated financial-contract substitute for gameplay tests. Real Redis atomic
// paths are tested separately in the backend; this never touches a live wallet.
export function seatFinanceAuthority(){
  const stored=new Map(),rounds=new Map(),calls=[],cashCalls=[];
  const account=uid=>stored.get(Number(uid));
  const common={
    async cashRead(input){return {...structuredClone(account(input.userId)),userId:input.userId,agentId:input.agentId,currency:input.currency};},
    async cashApply(request){
      cashCalls.push(structuredClone(request));const drafts=request.accounts.map(a=>{
        assert.equal(a.revision,account(a.userId).revision);return structuredClone(account(a.userId));
      });
      for(const op of request.steps){const next=drafts[op.account-1];
        assert.ok(['reserve','release','renew'].includes(op.kind),'a selected seat must not write money through cashApply');
        if(op.kind==='reserve'){next.carry||={token:op.token,tableKey:op.tableKey,amount:0,revision:0};next.carry.amount+=op.amount;next.carry.revision++;}
        else {assert.equal(next.carry.token,op.token);assert.equal(next.carry.tableKey,op.tableKey);assert.equal(next.carry.revision,op.revision);
          if(op.kind==='release'){next.carry.amount-=op.amount;next.carry.revision++;if(!next.carry.amount&&!op.keepOwner)next.carry=null;}}
      }
      const result={accounts:drafts.map((draft,i)=>{draft.revision++;draft.ttlMs=draft.carry?300000:0;stored.set(request.accounts[i].userId,draft);return {...request.accounts[i],...structuredClone(draft)};})};return result;
    },
    async finance(method,request){
      calls.push({method,request:structuredClone(request)});
      const base={code:0,roundId:request.roundId};let round=rounds.get(request.roundId);
      if(method==='bet'){
        if(!round){round={bets:new Map(),accounts:new Map(),phase:'BETTING'};rounds.set(request.roundId,round);}
        const items=request.items.map(item=>{
          if(round.bets.has(item.betId))return round.bets.get(item.betId).result;
          const amount=moneyToScore(item.amount),next=account(item.userId),carry=next.carry;
          if(item.carry){assert.equal(item.carry.token,carry.token);assert.equal(item.carry.tableKey,carry.tableKey);assert.equal(Number(item.carry.revision),carry.revision);assert.ok(amount<=carry.amount);
            if(amount){carry.amount-=amount;carry.revision++;}}
          else assert.ok(amount<=next.balance-(carry?.amount||0));
          if(amount){next.balance-=amount;next.revision++;}
          const result={betId:item.betId,userId:item.userId,code:0,accepted:true,currency:scoreToMoney(next.balance)};
          round.bets.set(item.betId,{item:structuredClone(item),result});round.accounts.set(item.userId,(round.accounts.get(item.userId)||0)+amount);return result;
        });
        return {...base,state:'BETTING',betDigest:'digest-'+round.bets.size,items};
      }
      assert.ok(round,'a financial round must have registered participants');
      if(method==='prePay')return {...base,success:true,state:'RESERVED',reservationId:'reservation-'+request.roundId,
        betDigest:request.betDigest,outcomeHash:request.outcomeHash,expiresAt:String(Math.floor(Date.now()/1000)+60)};
      if(method==='settlement'){
        if(round.result){assert.deepEqual(round.request,request);return round.result;}
        assert.equal(request.items.length,round.accounts.size);
        for(const item of request.items){
          const next=account(item.userId),carry=next.carry;
          if(item.carry){assert.equal(item.carry.token,carry.token);assert.equal(item.carry.tableKey,carry.tableKey);assert.equal(Number(item.carry.revision),carry.revision);}
          const effective=moneyToScore(item.betAmount);
          let delta;
          if(request.mode==='SEAT_NET'||request.mode==='BANKER_NET'&&item.netScore!==undefined&&item.netScore!==''){
            delta=signedFinanceScore(item.netScore);assert.ok(Number.isSafeInteger(delta));assert.equal(effective,Math.abs(delta));assert.equal(round.accounts.get(item.userId),0);
          }else {assert.equal(effective,round.accounts.get(item.userId));delta=moneyToScore(item.payout);}
          assert.ok(next.balance+delta>=0&&(!item.carry||carry.amount+delta>=0));
          if(delta||request.mode==='SEAT_NET'||request.mode==='BANKER_NET'){next.balance+=delta;next.revision++;if(item.carry){carry.amount+=delta;carry.revision++;}}
        }
        const result={...base,state:'SETTLED',settlementId:request.settlementId,items:request.items.map(item=>({userId:item.userId,code:0,currency:scoreToMoney(account(item.userId).balance)}))};
        round.result=result;round.request=structuredClone(request);return result;
      }
      if(method==='getRoundFinanceState')return {...base,state:round.result?'SETTLED':'BETTING'};
      if(method==='renewReservation')return {...base,success:true,state:'RESERVED',reservationId:request.reservationId,expiresAt:String(Math.floor(Date.now()/1000)+60)};
      assert.fail('Unexpected finance method: '+method);
    },
  };
  return {common,stored,calls,cashCalls,add(uid,balance=100000){stored.set(uid,{balance,carry:null,revision:0,ttlMs:0});},account};
}
