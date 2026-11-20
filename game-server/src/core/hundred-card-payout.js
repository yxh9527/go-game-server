import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, '../messages.js', v);
const { credit, walletOf } = await rel(import.meta.url, '../wallet/index.js', v);
const { hundredWalletContext } = await rel(import.meta.url, './robot.js', v);
const bankers = await rel(import.meta.url, './hundred-banker.js', v);
const {creditFinance,financeRound,usesLottery}=await rel(import.meta.url,'./hundred-finance.js',v);

function financialOutcome(table,result){
  return {inning:table.inning,winningAreas:result.areas,areaOdds:result.areaOdds||{},
    cards:result.showdownPokers||{other:result.player,banker:result.banker}};
}
export function reserveCardBets(io,table,adapter){
  const wallet=walletOf(io);if(!usesLottery(wallet,table))return;
  const result=table.lastResult,results=[];
  for(const [uid,bets]of table.playerBets){
    const session=table.playerSessions.get(uid)||io.sessionFor?.(uid);
    if(!session||session.bot||!bets.length)continue;
    const payment=adapter.calculate(table,result,bets);
    results.push({session,payout:payment.payout,record:{roomId:table.roomId,inning:table.inning,bets,
      areaWinningScores:payment.areaWinningScores,realScore:payment.realScore}});
  }
  const settlements=result.settlements||new Map();
  for(const [uid,bets]of table.playerBets)if(!settlements.has(uid))settlements.set(uid,adapter.calculate(table,result,bets));
  result.settlements=settlements;
  results.push(...bankers.financeResults(io,table,result,adapter.bankerAreas));
  wallet.reserveLottery(table,financeRound(table),results,financialOutcome(table,result));
}

export function settleCardBets(io, table, adapter) {
  const result = table.lastResult;
  if (!result || result.settled) {
    return;
  }
  if (result.cardPayoutTask) return result.cardPayoutTask;
  const task = Promise.resolve().then(() => payCardBets(io, table, adapter, result));
  result.cardPayoutTask = task;
  const clear = () => { if (result.cardPayoutTask === task) delete result.cardPayoutTask; };
  task.then(clear, clear);
  return task;
}

async function payCardBets(io, table, adapter, result) {
  result.settlements ||= new Map();
  const participants = new Map(table.playerSessions || []);
  const peers = new Map();
  const financeResults=[];
  io.forEachPlayer(session => {
    const uid = Number(session.userId);
    peers.set(uid, session.ws);
    if (!participants.has(uid)) participants.set(uid, session);
  });
  for (const [uid, session] of participants) {
    const mine = table.playerBets.get(session.userId) || [];
    let payment = result.settlements.get(uid);
    if (!payment) {
      payment = adapter.calculate(table, result, mine);
      if (!Number.isSafeInteger(payment.payout) || payment.payout < 0 || !Number.isSafeInteger(payment.realScore)) throw new Error('Invalid hundred-card payout total');
      result.settlements.set(uid, payment);
    }
    if (!payment.credited) {
      if(usesLottery(walletOf(io),table)&&!session.bot&&mine.length)financeResults.push({session,payout:payment.payout,
        record:{roomId:table.roomId,inning:table.inning,bets:mine,areaWinningScores:payment.areaWinningScores,realScore:payment.realScore}});
      const receipt = payment.payout > 0 ? await credit(session, payment.payout, hundredWalletContext(io, session),
        { operation: payment,...creditFinance(walletOf(hundredWalletContext(io,session)),table,'payout') }) : { ok: true };
      if (receipt?.ok === false) throw new Error('Hundred-card payout rejected');
      payment.credited = true;
    }
    if (!payment.persisted) {
      if (mine.length) await walletOf(hundredWalletContext(io, session)).persist?.(session);
      payment.persisted = true;
    }
    if (payment.notified) continue;
    const { realScore, areaWinningScores } = payment;
    const send = (id, payload) => {
      if (session.bot) return;
      if (io.sendUser) io.sendUser(uid, id, payload);
      else if (peers.has(uid)) io.send(peers.get(uid), id, payload);
    };
    send(PUSH.PLAYER_BALANCE_UPDATE, { points: session.wallet });
    send(PUSH.SHOWDOWN_POKERS, {
      roomType: table.roomType,
      roomId: table.roomId,
      ...adapter.resultPayload(table, result),
      winningAreas: result.areas,
      areaWinningScores,
      points: session.wallet,
      realScore,
      remainCardsNum: table.remainCardsNum,
      cutIndex: table.cutIndex,
    });
    send(PUSH.MB_ROOM_BET_SETTLE, { ...adapter.snapshot(table, session), realScore, areaWinningScores, customData: 2 });
    payment.notified = true;
    if (table.visitors && !table.visitors.has(uid)) table.playerSessions?.delete(uid);
  }
  financeResults.push(...bankers.financeResults(io,table,result,adapter.bankerAreas,true));
  bankers.settle(io, table, result, adapter.bankerAreas);
  if(usesLottery(walletOf(io),table))walletOf(io).settleLottery(table,financeRound(table),financeResults,
    financialOutcome(table,result));
  adapter.record(table, result, participants, io);
  result.settled = true;
  const historyResults=new Map([...result.settlements].map(([uid,p])=>[uid,{uid,score:p.realScore,walletAmount:participants.get(uid)?.wallet,
    xiaZhuData:(table.playerBets.get(uid)||[]).reduce((sum,b)=>sum+b.total,0)}]));
  for(const [uid,b]of result.bankerSettlements||[])if(!historyResults.has(uid)||historyResults.get(uid).xiaZhuData===0)
    historyResults.set(uid,{uid,score:b.score,xiaZhuData:Math.abs(b.score),banker:true});
  table.recordUserCenter?.([...historyResults.values()],
    {inning:table.inning,publicResult:{...adapter.resultPayload(table,result),winningAreas:result.areas},
      details:Object.fromEntries([...historyResults].map(([uid])=>{
        const p=result.settlements.get(uid),bank=result.bankerSettlements?.get(uid);
        return [uid,{areaWinningScores:p?.areaWinningScores||{},
          ...(bank?{bankerInningData:{bankerTotalWinLoseMap:result.bankerTotalWinLoseMap,bankerAreaTotalBet:{1:bank.normalTotalBet,2:bank.specialTotalBet},bankerInningInfoMap:{[uid]:{dataMap:Object.fromEntries(bank.areas.map(a=>[a.bankerType,{score:a.score,proportion:a.proportion}]))}}}}:{}),
          betDetailTableMap:Object.fromEntries((table.playerBets.get(uid)||[]).map(b=>[b.areaId,{areaId:b.areaId,betScore:b.total,realScore:p?.areaWinningScores[b.areaId]||0,
            score:b.total+(p?.areaWinningScores[b.areaId]||0),tax:0,odds:p?.betOdds?.[b.areaId]}]))}];
      }))});
  table.hundredSettledInning = table.inning;
}
