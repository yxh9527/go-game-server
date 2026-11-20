import {rel} from '../../game-server/src/rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {userInfoOf}=await rel(import.meta.url,'../../game-server/src/core/member.js',version);
export {formatHoldemReplayList as texasHistoryPayload,formatHoldemReplayDetail as texasHistoryDetail} from '../../shared/holdem-replay-format.js';

export function recordHand(table, hand, results) {
  const replayPlayers = (hand.participants || hand.statsPlayers || table.members).filter((m) => m.hole?.length).map((m) => {
    const result = results.find((item) => item.uid === m.uid);
    const userInfo = userInfoOf(m);
    return {
      uid: m.uid,
      userName: m.name,
      userIcon: userInfo.icon,
      pos: m.pos,
      score: result?.score || 0,
      isWin: Boolean(result?.isWin),
      openingPoint: m.openingPoint,
      cardTypeId: result?.cardTypeId || 0,
      cardTypeInfo: result?.cardTypeInfo,
      posName: m.posName,
      cards: [...m.hole, ...hand.board],
      handPais: [...m.hole],
      commonPoker: [...hand.board],
      showCards: Array.isArray(result?.showCards) && result.showCards.length
        ? result.showCards.slice(0, 2)
        : [-1, -1],
      operateList: hand.replayActions
        .filter((action) => action.uid === m.uid)
        .map(({ uid, replayOrder, ...action }) => action),
    };
  });
  table.history ||= [];
  // Dev replay is room-local; keep every completed hand until the room is retired.
  table.history.push({
    innerEndTime:Date.now(),
    gameRoomId: table.roomId,
    currentInningNum: table.currentInning,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: hand.initialBet ?? table.initialBet ?? table.bigBlind,
    playMode: hand.playMode ?? 0,
    pot: hand.pot,
    forceShowCard: Boolean(table.forceShowCard),
    firstGameList: replayPlayers,
    secondGameList: [],
    roundEvents: hand.replayEvents.map((event) => ({
      ...event,
      ...(Array.isArray(event.cards) ? { cards: event.cards.slice() } : {}),
      ...(Array.isArray(event.board) ? { board: event.board.slice() } : {}),
    })),
  });
}
