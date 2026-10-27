import { userInfoOf } from '../../game-server/src/core/member.js';
import { displaySeat, isCasino } from '../../game-server/src/games/blackjack/casino.js';
export function record(table, hand, results) {
  table.history ||= [];
  if (table.history.some(r => r.inning === table.currentInning)) return;
  const players = results.map(r => {
    const p = hand.players.find(p => p.uid === r.uid), profile = userInfoOf(p.member);
    return { uid: p.uid, pos: p.pos, displaySeat: isCasino(table) ? displaySeat(p.pos) : p.pos,
      name: profile.name, icon: profile.icon, banker: false,
      score: r.score, insuranceBet: r.insuranceAmount, insuranceProfit: r.insuranceProfit, handResults: structuredClone(r.handResults) };
  });
  const dealerAction = hand.actionList.filter(a => a.banker).at(-1);
  players.unshift({ uid: 0, name: '', icon: '15', banker: true, score: 0, insuranceBet: 0,
    insuranceProfit: 0, handResults: structuredClone(dealerAction.handResults) });
  // The dealer card row and the player-bankers are separate native sections.
  // Freeze the settled values, never read next hand's mutable banker entries.
  const bankerSettles = isCasino(table) ? Object.fromEntries([[1, 'normal'], [2, 'special']].map(([type, key]) =>
    [key, { bankers: (hand.bankers || []).filter(b => b.bankerType === type).map(b => ({
      uid: b.uid, name: b.entry.name, icon: b.entry.icon, proportion: b.entry.proportion, score: b.score,
    })) }])) : undefined;
  table.history.push({ inning: table.currentInning, createdAt: Date.now(), viewers: [...hand.viewers], players,
    ...(bankerSettles ? { bankerSettles } : {}) });
  table.history = table.history.filter(r => Date.now() - r.createdAt < 8 * 3600000).slice(-1000);
}
export function query(table, body, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const records = (table.history || []).filter(r => Date.now() - r.createdAt < 8 * 3600000
    && r.viewers.includes(Number(uid)) && room === table.roomId);
  const begin = Number(body.beginNum), inning = body.inningNum !== undefined ? Number(body.inningNum) : begin >= 0 ? begin + 1 : 0;
  const row = records.find(r => r.inning === inning) || (!(inning > 0) ? records.at(-1) : null);
  const players = row ? structuredClone(row.players) : [];
  if (isCasino(table)) for (const p of players) {
    if (p.banker) continue;
    // Earlier dev records omitted the seat. Recover only from that same hand,
    // never from today's seating or the row order (both may have changed).
    const pos = p.pos ?? (row.inning === table.currentInning ? table.hand?.players.find(m => m.uid === p.uid)?.pos : undefined);
    if (Number.isInteger(pos) && displaySeat(pos) > 0) {
      p.pos = pos; p.displaySeat = displaySeat(pos);
    } else if (p.displaySeat === undefined) {
      p.displaySeat = '未记录'; p.seatUnavailable = true;
    }
  }
  return { currentInning: row?.inning || 0, total: records.at(-1)?.inning || 0,
    gameBackInfo: { gameRoomId: table.roomId, gameId: table.roomId, roomTypeName: 'bj21', ante: table.ante,
      playMode: table.playMode || 0, inningInfo: [players],
      ...(row?.bankerSettles ? { bankerSettles: [structuredClone(row.bankerSettles)] } : {}) } };
}
