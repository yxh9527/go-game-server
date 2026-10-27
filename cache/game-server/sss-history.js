import { userInfoOf } from '../../game-server/src/core/member.js';

export function record(table, hand, results) {
  table.history ||= [];
  if (table.history.some(r => r.inning === table.currentInning)) return;
  const players = results.map(result => {
    const p = hand.players.find(p => p.uid === result.uid), profile = userInfoOf(p.member);
    return { ...structuredClone(result), userName: profile.name, userIcon: profile.icon };
  });
  table.history.push({ inning: table.currentInning, createdAt: Date.now(), viewers: [...hand.viewers],
    players, comparison: structuredClone(hand.comparison) });
  table.history = table.history.filter(r => Date.now() - r.createdAt < 8 * 3600000).slice(-1000);
}
export function query(table, body, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const records = (table.history || []).filter(r => r.viewers.includes(Number(uid)) && room === table.roomId);
  const begin = Number(body.beginNum), inning = body.inningNum !== undefined ? Number(body.inningNum) : begin >= 0 ? begin + 1 : 0;
  const row = records.find(r => r.inning === inning) || (!(inning > 0) ? records.at(-1) : null);
  return { gameRoomId: table.roomId, roomTypeName: 'sss', ante: table.ante,
    blind: JSON.stringify({ ante: table.ante }), totalNum: records.at(-1)?.inning || 0,
    dataInfo: row ? { currentInningNum: row.inning, firstGameList: structuredClone(row.players),
      compareResult: structuredClone(row.comparison), horseCardPosition: 26, playMode: table.playMode,
      endTime: row.createdAt, reportMsg: { reportFree: 0, bigBlind: 0, innerReport: false, playerList: [] } } : null };
}
