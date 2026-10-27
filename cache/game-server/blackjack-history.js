import { userInfoOf } from '../../game-server/src/core/member.js';
export function record(table, hand, results) {
  table.history ||= [];
  if (table.history.some(r => r.inning === table.currentInning)) return;
  const players = results.map(r => {
    const p = hand.players.find(p => p.uid === r.uid), profile = userInfoOf(p.member);
    return { uid: p.uid, name: profile.name, icon: profile.icon, banker: false,
      score: r.score, insuranceBet: r.insuranceAmount, insuranceProfit: r.insuranceProfit, handResults: structuredClone(r.handResults) };
  });
  const dealerAction = hand.actionList.filter(a => a.banker).at(-1);
  players.unshift({ uid: 0, name: '', icon: '15', banker: true, score: 0, insuranceBet: 0,
    insuranceProfit: 0, handResults: structuredClone(dealerAction.handResults) });
  table.history.push({ inning: table.currentInning, createdAt: Date.now(), viewers: [...hand.viewers], players });
  table.history = table.history.filter(r => Date.now() - r.createdAt < 8 * 3600000).slice(-1000);
}
export function query(table, body, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const records = (table.history || []).filter(r => Date.now() - r.createdAt < 8 * 3600000
    && r.viewers.includes(Number(uid)) && room === table.roomId);
  const begin = Number(body.beginNum), inning = body.inningNum !== undefined ? Number(body.inningNum) : begin >= 0 ? begin + 1 : 0;
  const row = records.find(r => r.inning === inning) || (!(inning > 0) ? records.at(-1) : null);
  return { currentInning: row?.inning || 0, total: records.at(-1)?.inning || 0,
    gameBackInfo: { gameRoomId: table.roomId, gameId: table.roomId, roomTypeName: 'bj21', ante: table.ante,
      playMode: table.playMode || 0, inningInfo: [row ? structuredClone(row.players) : []] } };
}
