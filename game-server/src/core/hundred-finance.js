// Shared by card, incremental-card and wheel games. Bots keep their room-only
// wallet. Financial identity stays on the actual inning through hot updates.
export function financeRound(table){
  const inning=Number(table.inning);
  if(!table.lotteryRound||table.lotteryRound.inning!==inning)table.lotteryRound={inning};
  return table.lotteryRound;
}
export function wagerFinance(wallet,table,bets,factor=1,attemptId){
  const controller=wallet.lotteryFor?wallet.lotteryFor(table):wallet.lottery;
  if(!controller)return undefined;
  const round=financeRound(table);controller.identity(table,round);
  return {finance:{kind:'bet',table,round,bets:bets.map(b=>({areaId:attemptId?'smart:'+attemptId+':'+String(b.areaId):String(b.areaId),amount:b.total*factor}))}};
}
export function creditFinance(wallet,table,kind){
  return (wallet.lotteryFor?wallet.lotteryFor(table):wallet.lottery)?{finance:{kind,table,round:financeRound(table)}}:{};
}
export const usesLottery=(wallet,table)=>!!(wallet.lotteryFor?wallet.lotteryFor(table):wallet.lottery);
