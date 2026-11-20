// Integer score units and decimal wire amounts. No account or round state.
const fail=(message,code='FINANCE_REJECTED')=>Object.assign(new Error(message),{code,status:503});
export function scoreToMoney(value,signed=false){
  if(!Number.isSafeInteger(value)||!signed&&value<0)throw fail('Invalid financial score','FINANCE_AMOUNT_INVALID');
  const amount=BigInt(value),absolute=amount<0n?-amount:amount;
  return (amount<0n?'-':'')+(absolute/100n)+'.'+String(absolute%100n).padStart(2,'0');
}
export function moneyToScore(value){
  if(typeof value!=='string'||!/^\d+(\.\d{1,2})?$/.test(value))throw fail('Invalid financial balance');
  const [whole,fraction='']=value.split('.'),amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw fail('Financial balance exceeds safe score range');
  return Number(amount);
}
