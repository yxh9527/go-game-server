import { userInfoOf } from '../../game-server/src/core/member.js';

export function recordHand(table, hand, results, conf) {
  table.history ||= [];
  if (table.history.some((r) => r.currentInningNum === table.currentInning)) return;
  table.history.push({ currentInningNum: table.currentInning, gameRoomId: table.roomId,
    innerEndTime: Date.now(), pot: hand.pot, conf, viewers: [...(hand.viewers || [])],
    events: structuredClone(hand.events || []),
    players: (hand.participants || hand.statsPlayers).map((p) => ({
      ...structuredClone(results.find((r) => r.uid === p.uid)),
      openingPoint: p.openingPoint ?? p.point + p.totalBet,
      userInfo: userInfoOf(p), ownCards: p.hole.slice(),
    })),
  });
}

function visiblePlayer(p, uid) {
  const { ownCards, ...result } = p;
  const cards = p.uid === Number(uid) ? ownCards : p.showCards;
  return { ...result, handPais: cards.slice(), showCards: cards.slice() };
}

function detailEvents(record) {
  const players = new Map(record.players.map((p) => [Number(p.uid), p]));
  return record.events.map((event) => {
    const player = players.get(Number(event.uid));
    // The original history row calls trim() on nickName || name || uid.
    // Read the archived profile, not today's room members; enrich at query
    // time so hands recorded before this fix are compatible as well.
    const name = [player?.userInfo?.name, player?.name, event.nickName, event.name]
      .find((value) => (typeof value === 'string' && value.trim())
        || (typeof value === 'number' && Number.isFinite(value)));
    return { ...event, nickName: String(name ?? event.uid) };
  });
}

export function historyPayload(table, request = {}, uid) {
  const allowed = (table.history || []).filter((r) => r.viewers.includes(Number(uid))
    && (!request.roomId || Number(request.roomId) === Number(table.roomId)));
  const available = allowed.filter((r) => !request.excellentGame || r.events.some((e) => e.operationType === 6));
  const begin = Number(request.beginNum), end = Number(request.endNum);
  const latest = (!Number.isFinite(begin) || begin < 0) && (!Number.isFinite(end) || end < 0);
  const allExcellent = request.excellentGame && begin === 0 && end === 0;
  const list = latest || allExcellent ? available.slice(-20) : available.filter((r) =>
    (!Number.isFinite(begin) || begin < 0 || r.currentInningNum >= Math.trunc(begin) + 1)
    && (!Number.isFinite(end) || end < 0 || r.currentInningNum <= Math.trunc(end) + 1)).slice(0, 20);
  return { gameRoomId: table.roomId, roomTypeName: 'ctjh', isOfflineData: false,
    excellentGame: Boolean(request.excellentGame), blind: JSON.stringify({ ante: table.ante, initialBet: table.ante }),
    beginNum: list[0]?.currentInningNum || 0, endNum: list.at(-1)?.currentInningNum || 0,
    totalNum: allowed.at(-1)?.currentInningNum || 0,
    playBackList: list.map((r) => ({ gameRoomId: table.roomId, currentInningNum: r.currentInningNum,
      pot: r.pot, innerEndTime: r.innerEndTime, insurance: 0, collect: false, excellentGame: false,
      currentInningJoin: r.players.some((p) => p.uid === Number(uid)),
      reportMsg: { reportFree: 0, bigBlind: 0, innerReport: false, playerList: [] },
      firstGameList: r.players.map((p) => {
        const row = visiblePlayer(p, uid);
        return { ...row, userName: p.name, userIcon: p.icon, posName: p.pos + 1, posType: p.pos + 1,
          cardTypePokers: row.handPais, totalInsuranceAmount: 0, winInsuranceScore: 0,
          operateList: [
            { operate: 0, gameState: 3, cards: row.handPais, bet: 0 },
            ...r.events.filter((e) => e.uid === p.uid).map((e) => ({ ...e, operate: e.operationType })),
          ] };
      }), secondGameList: [],
    })),
  };
}

export function historyDetail(table, inning, uid) {
  const record = (table.history || []).find((r) => r.currentInningNum === Number(inning)
    && r.viewers.includes(Number(uid)));
  if (!record) return null;
  return { exploitsInfoMsgs: [{ gameInningId: table.roomId + '_' + inning,
    gameRoomUnion: { gameRoomId: table.roomId, roomConfig: JSON.stringify(record.conf) },
    inningResults: JSON.stringify(record.players.map((p) => visiblePlayer(p, uid))),
    inningInfo: JSON.stringify({ forceShowCard: record.conf.ctjhParams.forceShowCard }),
    roundList: JSON.stringify(detailEvents(record)),
    memberResults: record.players.map((p) => ({ uid: p.uid, pos: p.pos, userInfo: p.userInfo,
      openingPoint: p.openingPoint, point: p.openingPoint, score: p.score })),
  }] };
}
