import {lateRegistrationOpen} from '../../shared/tournament-registration.js';

// A read-only projection; financial receipts stay in the existing runtime record.
export function adminMatch(row,state={},at=Date.now()) {
  const clock=state.clock||{},entries=Object.values(state.registrations||{});
  const payments=entries.flatMap(e=>[e,...(e.reentries||[])]),prizes=state.prizes||[];
  const late=lateRegistrationOpen(row,clock,at),seconds=Number(row.delay_register_time||0);
  return {...row,tournament_clock:clock,admin:{
    serverNow:at,lateOpen:late,lateLevel:Number(row.delay_register_level||0),
    lateDeadline:seconds>0?Number(row.start_time)+seconds*1000+Number(clock.registrationDelayMs||0):0,
    pause:state.manualPause||null,archived:Boolean(state.archived),
    locked:Number(row.state)>=2||payments.some(e=>['registered','playing','pending','refund_pending'].includes(e.status)),
    invalidated:state.invalidated||null,cancelReason:state.cancelReason||'',
    refundsPending:payments.filter(e=>e.status==='refund_pending').length,
    refundsCompleted:payments.filter(e=>e.status==='refunded').length,
    paymentsPending:payments.filter(e=>e.status==='pending').length,
    prizesPending:prizes.filter(e=>e.status!=='paid').length,
    prizesPaid:prizes.filter(e=>e.status==='paid').length,
    errors:[...payments,...prizes].filter(e=>e.lastError).map(e=>({userId:e.userId||e.plan?.userId,status:e.status,message:e.lastError})).slice(0,100),
  }};
}
