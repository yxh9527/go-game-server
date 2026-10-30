import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { PUSH } = await rel(import.meta.url, '../messages.js', v);
const { credit, walletOf } = await rel(import.meta.url, '../wallet/index.js', v);
const { hundredWalletContext } = await rel(import.meta.url, './robot.js', v);
const bankers = await rel(import.meta.url, './hundred-banker.js', v);

export async function settleCardBets(io, table, adapter) {
  const result = table.lastResult;
  if (!result || result.settled) {
    return;
  }
  result.settlements ||= new Map();
  const participants = new Map(table.playerSessions || []);
  const peers = new Map();
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
      const receipt = payment.payout > 0 ? await credit(session, payment.payout, hundredWalletContext(io, session)) : { ok: true };
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
  bankers.settle(io, table, result, adapter.bankerAreas);
  adapter.record(table, result, participants, io);
  result.settled = true;
  table.hundredSettledInning = table.inning;
}
