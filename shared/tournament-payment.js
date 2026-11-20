const integer=n=>Number.isSafeInteger(n)&&n>=0;
export function tournamentPaymentMode(plan,row,paymentType=2){
  if(![1,2].includes(paymentType))throw Object.assign(new Error('无效的报名支付方式'),{status:400});
  const result={...plan};delete result.ticketOnly;delete result.ticketCredit;
  const credit=Number(row.allow_ticket_pay??1)===1&&Number(plan.ticketId)>0&&plan.total>0;
  if(credit)result.ticketCredit=true;
  return result;
}
export function ticketRateFraction(value){
  const text=String(value),match=/^(\d+)(?:\.(\d{1,8}))?$/.exec(text);
  if(text.length>32||!match)throw new Error('Invalid ticket exchange rate');
  const scale=10n**BigInt((match[2]||'').length),units=BigInt(match[1])*scale+BigInt(match[2]||'0');
  if(units<=0n||units>BigInt(Number.MAX_SAFE_INTEGER)*scale)throw new Error('Invalid ticket exchange rate');
  return {units,scale};
}
export function verifyTournamentCharge(plan,receipt){
  if(!receipt||receipt.key!==plan.key||receipt.currency!==plan.currency||![receipt.paidGold,receipt.paidService].every(integer))throw new Error('Payment receipt does not match the original plan');
  let credit=0,count=0;
  if(plan.ticketCredit){
    credit=receipt.ticketCreditAmount;count=receipt.creditTicketCount;
    if(!integer(credit)||credit>plan.total||!integer(count)||count>1000||receipt.grossGold!==plan.gold||receipt.grossService!==plan.service)throw new Error('Invalid ticket credit receipt');
    const {units,scale}=ticketRateFraction(receipt.ticketRate);
    if(BigInt(count)*100n*scale/units!==BigInt(credit)||BigInt(count)*100n*scale>BigInt(plan.total)*units)throw new Error('Ticket credit amount disagrees with its locked rate');
    if(count>0&&credit===0)throw new Error('Ticket credit consumed tickets without an offset');
  }
  const goldCredit=Math.min(credit,plan.gold);
  if(receipt.paidGold!==plan.gold-goldCredit||receipt.paidService!==plan.service-(credit-goldCredit))throw new Error('Cash fees disagree with ticket credit');
  const tickets=(plan.ticketCount||0)+count;
  if(tickets>1000)throw new Error('Ticket payment exceeds transaction limits');
  if((tickets>0||plan.ticketCredit)&&(receipt.paidTicketCount!==tickets||receipt.ticketId!==plan.ticketId))throw new Error('Ticket ownership receipt mismatch');
  return {cash:receipt.paidGold+receipt.paidService,tickets};
}
