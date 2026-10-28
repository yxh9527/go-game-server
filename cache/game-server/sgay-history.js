import { userInfoOf } from '../../game-server/src/core/member.js';

export function record(table, hand, results) {
  table.history ||= [];
  if (table.history.some(r => r.inning === table.currentInning)) return;
  table.history.push({ inning: table.currentInning, createdAt: Date.now(), pot: hand.pot, viewers: [...hand.viewers],
    rules: structuredClone(hand.rules),
    events: structuredClone(hand.events), players: results.map(result => {
      const p = hand.players.find(p => p.uid === result.uid), profile = userInfoOf(p.member);
      return { ...structuredClone(result), userName: profile.name, userIcon: profile.icon,
        userInfo: structuredClone(profile), openingPoint: p.openingPoint,
        posType: p.pos + 1, posName: String(p.pos + 1), cardTypePokers: result.handPais.slice(),
        commonPoker: result.handPais.slice(), totalInsuranceAmount: 0, winInsuranceScore: 0,
        operateList: [{ operate: 0, gameState: 3, cards: result.handPais.slice(), bet: 0 },
          ...hand.events.filter(e => e.uid === p.uid).map(e => ({ ...e, operate: e.operationType }))] };
    }) });
  table.history = table.history.filter(r => Date.now() - r.createdAt < 8 * 3600000).slice(-1000);
}
export function query(table, body = {}, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const records = (table.history || []).filter(r => Date.now() - r.createdAt < 8 * 3600000
    && r.viewers.includes(Number(uid)) && room === table.roomId);
  const begin = Number(body.beginNum), end = Number(body.endNum), inning = Number(body.inningNum);
  const latest = !(inning > 0) && !(begin >= 0) && !(end >= 0);
  const selected = latest ? records.slice(-1) : records.filter(r => !(inning > 0) || r.inning === inning)
    .filter(r => !(begin >= 0) || r.inning >= begin + 1)
    .filter(r => !(end >= 0) || r.inning <= end + 1).slice(-20);
  return { gameRoomId: table.roomId, roomTypeName: 'sgya', blind: JSON.stringify({ ante: table.ante }),
    excellentGame: Boolean(body.excellentGame), isOfflineData: false,
    beginNum: selected[0]?.inning || 0, endNum: selected.at(-1)?.inning || 0,
    totalNum: records.at(-1)?.inning || 0, playBackList: selected.map(r => ({
      gameRoomId: table.roomId, currentInningNum: r.inning, innerEndTime: r.createdAt,
      currentInningJoin: r.players.some(p => p.uid === Number(uid)), pot: r.pot,
      insurance: 0, collect: false, excellentGame: false,
      firstGameList: structuredClone(r.players), secondGameList: [],
      reportMsg: { reportFree: 0, bigBlind: 0, innerReport: false, playerList: [] } })) };
}

export function historyDetail(table, inning, uid) {
  const row = (table.history || []).find(r => r.inning === Number(inning)
    && Date.now() - r.createdAt < 8 * 3600000 && r.viewers.includes(Number(uid)));
  if (!row) return null;
  const profiles = new Map(row.players.map(p => [p.uid, p]));
  let pot = 0;
  const events = row.events.map(e => {
    if (e.operationType === 1) pot += e.bet;
    const p = profiles.get(e.uid);
    return { ...e, currentRounds: e.operationType === 1 ? 0 : 1, pot,
      nickName: String(p.userName), name: String(p.userName), icon: p.userIcon };
  });
  return { exploitsInfoMsgs: [{ gameInningId: table.roomId + '_' + row.inning,
    gameRoomUnion: { gameRoomId: table.roomId,
      roomConfig: JSON.stringify({ roomType: 'sgya', sgyaParams: row.rules }) },
    inningResults: JSON.stringify(row.players),
    inningInfo: JSON.stringify({ ante: row.rules?.ante ?? table.ante }),
    roundList: JSON.stringify(events),
    memberResults: row.players.map(p => ({ uid: p.uid, pos: p.pos, userInfo: p.userInfo,
      openingPoint: p.openingPoint, point: p.openingPoint, score: p.score })) }] };
}
