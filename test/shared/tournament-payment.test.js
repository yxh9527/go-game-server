import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyTournamentCharge,ticketRateFraction,tournamentPaymentMode} from '../../shared/tournament-payment.js';

const plan={key:'match:7:9:42:1',gold:100,service:10,total:110,currency:'CNY',ticketId:5,ticketCount:1,ticketCredit:true};
const receipt={key:plan.key,currency:'CNY',grossGold:100,grossService:10,paidGold:80,paidService:10,paidTicketCount:21,ticketId:5,
  ticketCreditAmount:20,creditTicketCount:20,ticketRate:'100'};
test('100 tickets per currency unit means each ticket offsets one score; cash and original required tickets remain separate',()=>{
  assert.deepEqual(verifyTournamentCharge(plan,receipt),{cash:90,tickets:21});
  assert.deepEqual(verifyTournamentCharge({...plan,ticketCount:0},{...receipt,paidTicketCount:20}),{cash:90,tickets:20});
  assert.deepEqual(verifyTournamentCharge(plan,{...receipt,paidGold:0,paidService:0,paidTicketCount:111,creditTicketCount:110,ticketCreditAmount:110}),{cash:0,tickets:111});
});
test('ticket credit rejects changed gross fees, unbacked offsets, over-consumption and invalid rates',()=>{
  for(const patch of [{grossGold:99},{paidGold:81},{ticketCreditAmount:21},{paidTicketCount:20},{ticketId:6},{ticketRate:'0'},{ticketRate:'NaN'},{creditTicketCount:111,paidTicketCount:112,ticketCreditAmount:111},
    {creditTicketCount:1,paidTicketCount:2,ticketRate:'200',ticketCreditAmount:0,paidGold:100}])assert.throws(()=>verifyTournamentCharge(plan,{...receipt,...patch}));
  assert.throws(()=>ticketRateFraction('0.000000001'));assert.throws(()=>ticketRateFraction('1e2'));
});

test('both native selections use available tickets and allow cash for uncovered fees',()=>{
  const selected=tournamentPaymentMode(plan,{register_type:3,allow_ticket_pay:1},1);
  assert.equal(selected.ticketOnly,undefined);assert.equal(selected.ticketCredit,true);
  assert.deepEqual(verifyTournamentCharge(selected,receipt),{cash:90,tickets:21});
  assert.deepEqual(tournamentPaymentMode(plan,{allow_ticket_pay:1},2),selected);
  assert.deepEqual(verifyTournamentCharge({...selected,ticketOnly:true},receipt),{cash:90,tickets:21});
  assert.equal(tournamentPaymentMode(plan,{allow_ticket_pay:0},1).ticketCredit,undefined);
  assert.equal(tournamentPaymentMode({...plan,ticketId:0},{allow_ticket_pay:1},1).ticketCredit,undefined);
  assert.throws(()=>tournamentPaymentMode(plan,{},3));
});
