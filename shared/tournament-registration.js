export function lateRegistrationOpen(row,clock,at=Date.now()){
  if(Number(row.state)!==2||row.invalidated||clock?.pauseRequested)return false;
  const level=Number(row.delay_register_level||0),seconds=Number(row.delay_register_time||0),start=Number(row.start_time);
  if(![level,seconds].every(n=>Number.isSafeInteger(n)&&n>=0)||!Number.isSafeInteger(start)||at<start||level+seconds<=0)return false;
  const deadline=start+seconds*1000+Number(clock?.registrationDelayMs||0);
  if(seconds>0&&(!Number.isSafeInteger(deadline)||at>=deadline))return false;
  if(level>0&&(!Number.isSafeInteger(clock?.currentBlindLv)||clock.currentBlindLv<=0||clock.currentBlindLv>level))return false;
  if(level>0&&Number(clock?.nextBlindAt)>0&&at>=Number(clock.nextBlindAt))return false;
  return true;
}
export const registrationOpen=(row,entry,clock,at=Date.now())=>entry?.late
  ?(!entry.reentry||entry.reentryNumber>0&&entry.reentryNumber<=Number(row.rebuy_time||0))&&lateRegistrationOpen(row,clock,at):Number(row.state)===1&&at<Number(row.start_time);
