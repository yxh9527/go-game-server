import { userInfoOf } from '../../game-server/src/core/member.js';
const TTL = 8 * 3600000;
export function record(table, hand, result) {
  table.mahjongHistory ||= [];
  if (table.mahjongHistory.some(r => r.inning === table.currentInning)) return;
  table.mahjongHistory.push({ inning: table.currentInning, time: Date.now(), viewers: [...hand.viewers],
    rules: structuredClone(hand.rules), bankerPos: hand.bankerPos, result: structuredClone(result), events: structuredClone(hand.events),
    profiles: hand.players.map(p => userInfoOf(p.member)) });
  table.mahjongHistory = table.mahjongHistory.filter(r => Date.now() - r.time < TTL).slice(-1000);
}
export function query(table, body = {}, uid) {
  const room = Number(body.roomId ?? body.gameRoomId ?? table.roomId);
  const list = (table.mahjongHistory || []).filter(r => room === table.roomId && r.viewers.includes(Number(uid)) && Date.now() - r.time < TTL);
  const inning = Number(body.inningNum), begin = Number(body.beginNum), end = Number(body.endNum);
  const selected = inning > 0 ? list.filter(r => r.inning === inning) : begin >= 0 || end >= 0
    ? list.filter(r => (!(begin >= 0) || r.inning >= begin + 1) && (!(end >= 0) || r.inning <= end + 1)).slice(-20) : list.slice(-1);
  return { gameRoomId: table.roomId, roomTypeName: table.roomRules.family,
    diFen: table.ante,
    blind: JSON.stringify({ diFen: table.ante, ante: table.ante }), totalNum: list.at(-1)?.inning || 0,
    beginNum: selected[0]?.inning || 0, endNum: selected.at(-1)?.inning || 0, isOfflineData: false,
    playBackList: selected.map(r => ({ gameRoomId: table.roomId, currentInningNum: r.inning, innerEndTime: r.time,
      ...r.result, bankerPos: r.bankerPos,
      flowerFan: Object.fromEntries(r.result.resultList.map(p => [p.uid, p.flowerFan])),
      gangFan: Object.fromEntries(r.result.resultList.map(p => [p.uid, p.gangFan])),
      playerList: r.result.resultList.map(p => ({ ...p, userInfo: r.profiles.find(u => u.uid === p.uid),
        userName: p.name, userIcon: r.profiles.find(u => u.uid === p.uid)?.icon, handPais: p.handCards, paiList: p.handCards,
        isBanker: p.pos === r.bankerPos, isWinner: p.uid === r.result.winUid })),
      roundList: r.events, currentInningJoin: r.result.resultList.some(p => p.uid === Number(uid)) })) };
}
export function historyDetail(table, inning, uid) {
  const r = (table.mahjongHistory || []).find(r => r.inning === Number(inning) && r.viewers.includes(Number(uid)) && Date.now() - r.time < TTL);
  if (!r) return null;
  return { exploitsInfoMsgs: [{ gameInningId: table.roomId + '_' + r.inning,
    gameRoomUnion: { gameRoomId: table.roomId, roomConfig: JSON.stringify({ roomType: r.rules.family, playMode: r.rules.playMode,
      [r.rules.family + 'Params']: r.rules }) },
    inningResults: JSON.stringify(r.result.resultList.map(p => ({ ...p, handPais: p.handCards, banker: p.pos === r.bankerPos }))),
    inningInfo: JSON.stringify({ ...r.rules, userGameBackDetailMap: Object.fromEntries(r.result.resultList.map(p => [p.uid, p])) }),
    roundList: JSON.stringify(r.events.map(e => ({ ...e, operationType: e.type, currentRounds: e.inningRound, pot: 0 }))),
    memberResults: r.result.resultList.map(p => ({ uid: p.uid, pos: p.pos, score: p.score, point: p.innerStartPoint,
      userInfo: r.profiles.find(u => u.uid === p.uid) })) }] };
}
