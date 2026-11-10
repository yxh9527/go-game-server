// Match gogames/data-center/dao/gogame_cash.go; keep each game commit atomic.
export const MAX_CASH_ACCOUNTS=1024;
export const MAX_CASH_STEPS=4096;
// Twenty banker slots plus room bookkeeping fit in the remaining 24.
export const MAX_HUNDRED_BETTORS=1000;
export function canAddHundredBettor(table,userId){
  if(table.playerBets?.get(Number(userId))?.length)return true;
  let count=0;
  for(const [uid,bets]of table.playerBets||[]){
    if(!bets?.length)continue;
    if(Number(uid)===Number(userId))return true;
    count++;
  }
  return count<MAX_HUNDRED_BETTORS;
}
