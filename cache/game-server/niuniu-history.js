import { userInfoOf } from '../../game-server/src/core/member.js';

export function record(table, hand, results) {
  table.history ||= [];
  if (table.history.some(row => row.inning === table.currentInning)) return;
  const players = results.map(result => {
    const member = hand.players.find(p => p.uid === result.uid);
    const profile = userInfoOf(member);
    return { ...structuredClone(result), userName: profile.name, userIcon: profile.icon,
      seeCardNo: (hand.rules || table.roomRules).seeCardNo,
      handCardListWithLaiZi: table.playMode === 7 ? result.handCardListWithLaiZi.slice() : [],
      posType: result.banker ? 1 : 0, cardTypePokers: result.handPais.slice() };
  });
  table.history.push({ inning: table.currentInning, createdAt: Date.now(),
    viewers: [...hand.viewers], seeCardNo: (hand.rules || table.roomRules).seeCardNo, players });
  table.history = table.history.filter(row => Date.now() - row.createdAt < 8 * 3600000).slice(-1000);
}

export function query(table, body, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const records = (table.history || []).filter(r => r.viewers.includes(Number(uid)) && room === table.roomId);
  const page = Number(body.beginNum);
  const inning = body.inningNum !== undefined ? Number(body.inningNum) : page >= 0 ? page + 1 : 0;
  const row = records.find(r => r.inning === inning) || (!(inning > 0) ? records.at(-1) : null);
  return { gameRoomId: table.roomId, roomTypeName: 'qznn', ante: table.ante, seeCardNo: row?.seeCardNo ?? table.roomRules.seeCardNo,
    blind: JSON.stringify({ ante: table.ante, seeCardNo: table.roomRules.seeCardNo }),
    totalNum: records.at(-1)?.inning || 0,
    dataInfo: { currentInningNum: row?.inning || inning || 0, firstGameList: row?.players || [],
      playMode: table.playMode, endTime: row?.createdAt || 0,
      reportMsg: { reportFree: 0, bigBlind: 0, innerReport: false, playerList: [] } } };
}
