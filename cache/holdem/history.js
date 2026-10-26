import { OP } from "../../game-server/src/games/holdem/op.js";
import { evaluate7 } from "../../game-server/src/games/holdem/cards.js";
import { REPLAY_GAME_STATE } from "../../game-server/src/games/holdem/replay-state.js";
import { rel } from "../../game-server/src/rel.js";
const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { userInfoOf } = await rel(import.meta.url, "../../game-server/src/core/member.js", version);

function hasVisibleHoleCards(cards) {
  return Array.isArray(cards) && cards.length >= 2
    && cards.slice(0, 2).every((card) => card != null && Number(card) !== -1);
}

function historyPlayerHoleCards(player) {
  if (Array.isArray(player?.showCards)) return player.showCards.slice(0, 2);
  const cards = Array.isArray(player?.cards) ? player.cards : [];
  if (hasVisibleHoleCards(cards)) return cards.slice(0, 2);
  const dealt = (Array.isArray(player?.operateList) ? player.operateList : [])
    .find((action) => Number(action?.gameState) === 3 && hasVisibleHoleCards(action?.cards));
  if (hasVisibleHoleCards(dealt?.cards)) return dealt.cards.slice(0, 2);
  return hasVisibleHoleCards(player?.handPais) && player.handPais.length === 2
    ? player.handPais.slice()
    : [];
}

function historyPlayerHasFolded(player) {
  if (player?.folded) return true;
  return (Array.isArray(player?.operateList) ? player.operateList : []).some((action) =>
    Number(action?.operate ?? action?.operationType) === OP.ABANDON);
}

function historyPlayerCanShowCards(player, forceShowCard) {
  if (forceShowCard) return true;
  if (Array.isArray(player?.showCards)) return hasVisibleHoleCards(player.showCards);
  if (player?.showCards != null) return Boolean(player.showCards);
  return !historyPlayerHasFolded(player) && hasVisibleHoleCards(historyPlayerHoleCards(player));
}

function historyPlayerForClient(player, index, forceShowCard) {
  const uid = Number(player?.uid) || 0;
  const score = Number(player?.score) || 0;
  const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
  const holeCards = historyPlayerHoleCards(player);
  const visibleHoleCards = holeCards.length === 2 && (canShowCards || Array.isArray(player?.showCards))
    ? holeCards.map((card) => Number.isInteger(card) && card >= 0 && card < 52 ? card : -1) : [-1, -1];
  const fullCards = Array.isArray(player?.cards) ? player.cards.slice() : [];
  const commonPoker = Array.isArray(player?.commonPoker) && player.commonPoker.length
    ? player.commonPoker.slice()
    : (fullCards.length >= 7 ? fullCards.slice(2, 7) : []);
  const cardTypeInfo = player?.cardTypeInfo || {};
  const evaluatedHand = canShowCards && holeCards.length === 2 && commonPoker.length >= 5
    ? evaluate7([...holeCards, ...commonPoker.slice(0, 5)])
    : null;
  const storedBestHand = Array.isArray(cardTypeInfo.handCardList) && cardTypeInfo.handCardList.length
    ? cardTypeInfo.handCardList
    : (Array.isArray(player?.cardTypePokers) && player.cardTypePokers.length
      ? player.cardTypePokers
      : null);
  const bestHand = storedBestHand
    ? storedBestHand.slice()
    : (evaluatedHand?.best5 || (Array.isArray(player?.handPais) ? player.handPais.slice() : []));
  const storedCardTypeId = Number(cardTypeInfo.cardTypeId ?? player?.cardTypeId);
  const cardTypeId = canShowCards
    ? (storedCardTypeId > 0 ? storedCardTypeId : (evaluatedHand?.cardTypeId || 0))
    : -1;
  const sourceUserInfo = player?.userInfo || {};
  const userInfo = userInfoOf({
    uid,
    name: player?.userName ?? sourceUserInfo.userName ?? sourceUserInfo.name ?? player?.name,
    icon: player?.userIcon ?? player?.icon ?? sourceUserInfo.userIcon ?? sourceUserInfo.icon,
  });
  const posName = Number(player?.posName);
  const seatPos = Number(player?.pos);
  const actions = (Array.isArray(player?.operateList) ? player.operateList : [])
    .filter((action) => ![3, 5, 7, 9].includes(Number(action?.gameState)))
    .map((action) => {
      const { cards, replayOrder, ...row } = action || {};
      const operation = Number(row.operate ?? row.operationType) || 0;
      return {
        ...row,
        operate: operation,
        operationType: Number(row.operationType ?? row.operate) || operation,
      };
    });
  const cardStages = [
    { operate: 0, operationType: 0, gameState: 3, cards: visibleHoleCards },
  ];
  if (commonPoker.length >= 3) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 5, cards: commonPoker.slice(0, 3) });
  }
  if (commonPoker.length >= 4) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 7, cards: [commonPoker[3]] });
  }
  if (commonPoker.length >= 5) {
    cardStages.push({ operate: 0, operationType: 0, gameState: 9, cards: [commonPoker[4]] });
  }
  const summary = { ...player };
  for (const key of ["openingPoint", "cardTypeInfo", "icon", "userIcon", "posName", "showCards", "cards", "handPais", "commonPoker", "operateList"]) {
    delete summary[key];
  }
  const cards = fullCards.length
    ? fullCards
    : [...holeCards, ...commonPoker];
  if (!canShowCards) {
    cards[0] = visibleHoleCards[0];
    cards[1] = visibleHoleCards[1];
  }
  const isWin = player?.isWin == null ? score > 0 : Boolean(player.isWin);
  return {
    ...summary,
    uid,
    userName: userInfo.name,
    userIcon: userInfo.icon,
    userInfo: { ...userInfo, userName: userInfo.name, userIcon: userInfo.icon },
    posName: Number.isInteger(posName) && posName >= 1 && posName <= 10
      ? posName
      : (Number.isInteger(seatPos) && seatPos >= 0 && seatPos < 10 ? seatPos : index % 10) + 1,
    score,
    isWin,
    cardTypeId,
    cardTypePokers: canShowCards ? bestHand : [],
    handPais: canShowCards ? bestHand : [],
    showCards: visibleHoleCards,
    cards,
    commonPoker,
    operateList: [...actions, ...cardStages],
  };
}

// Development history is volatile and scoped to the room's in-memory table.
export function texasHistoryPayload(table, request = {}) {
  const roomId = Number(request.roomId);
  const begin = Number(request.beginNum);
  const end = Number(request.endNum);
  const excellentGame = Boolean(request.excellentGame);
  const available = (table.history || []).filter((item) =>
    (!roomId || Number(item.gameRoomId) === roomId)
    && (!excellentGame || item.firstGameList.some((player) =>
      player.operateList.some((action) => action.operate === OP.ALL_IN))),
  ).sort((a, b) => Number(a.currentInningNum) - Number(b.currentInningNum));

  // The online client sends inningNum - 1 in beginNum/endNum. Negative bounds
  // request the latest page; excellent mode's 0/0 request asks for all matches.
  const excellentAll = excellentGame && begin === 0 && end === 0;
  const latestPage = (!Number.isFinite(begin) || begin < 0)
    && (!Number.isFinite(end) || end < 0);
  let list;
  if (excellentAll) {
    list = available;
  } else if (latestPage) {
    list = available.slice(-20);
  } else {
    const firstInning = Number.isFinite(begin) && begin >= 0 ? Math.trunc(begin) + 1 : Number.MIN_SAFE_INTEGER;
    const lastInning = Number.isFinite(end) && end >= 0 ? Math.trunc(end) + 1 : Number.MAX_SAFE_INTEGER;
    list = available.filter((item) =>
      Number(item.currentInningNum) >= firstInning
      && Number(item.currentInningNum) <= lastInning);
    list = list.slice(0, 20);
  }
  const totalNum = available.reduce((max, item) => Math.max(max, Number(item.currentInningNum) || 0), 0);
  return {
    excellentGame,
    isOfflineData: false,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
    beginNum: list.length ? list[0].currentInningNum : 0,
    endNum: list.length ? list[list.length - 1].currentInningNum : 0,
    totalNum,
    roomTypeName: "dzpk",
    // The client's HistoryModel.getBlind parses this field as JSON, then
    // formats the score values into display units.
    blind: JSON.stringify({
      smallBlind: table.smallBlind,
      bigBlind: table.bigBlind,
      initialBet: table.bigBlind,
      isStraddle: false,
    }),
    gameRoomId: table.roomId,
    playBackList: list.map(({ roundEvents, forceShowCard, ...item }) => ({
      ...item,
      firstGameList: (item.firstGameList || []).map((player, index) =>
        historyPlayerForClient(player, index, forceShowCard)),
      secondGameList: (item.secondGameList || []).map((player, index) =>
        historyPlayerForClient(player, index, forceShowCard)),
    })),
  };
}

// Adapt the volatile development replay into the same detail envelope the
// Holdem history panel reads from hall op=46. Production detail remains owned
// by data-center and is intentionally not served from this room memory.
export function texasHistoryDetail(table, inningNum) {
  const inning = Number(inningNum);
  const replay = (table.history || []).find((item) => Number(item.currentInningNum) === inning);
  if (!replay) return null;
  const players = replay.firstGameList || [];
  const forceShowCard = Boolean(replay.forceShowCard ?? table.forceShowCard);
  const fallbackActions = players.flatMap((player) => {
    return (player.operateList || []).map((action) => ({
      ...action,
      uid: Number(player.uid),
    }));
  });
  const hasRecordedTimeline = Array.isArray(replay.roundEvents);
  let events = hasRecordedTimeline
    ? replay.roundEvents.map((event) => ({ ...event }))
    : fallbackActions;
  if (!hasRecordedTimeline) {
    // Older in-memory histories lack cross-player order; reconstruct street and
    // pot progression as the best available fallback. New hands record sequence.
    events.sort((a, b) => Number(a.gameState || 0) - Number(b.gameState || 0)
      || Number(a.pot || 0) - Number(b.pot || 0));
    const board = players.find((player) => Array.isArray(player.commonPoker))?.commonPoker || [];
    const deals = [
      { gameState: REPLAY_GAME_STATE.DEAL_FLOP, cardCount: 3 },
      { gameState: REPLAY_GAME_STATE.DEAL_TURN, cardCount: 4 },
      { gameState: REPLAY_GAME_STATE.DEAL_RIVER, cardCount: 5 },
    ].filter((deal) => board.length >= deal.cardCount).map((deal) => {
      const nextAction = events.find((event) => Number(event.gameState) > deal.gameState);
      return {
        ...deal,
        uid: 0,
        operationType: 0,
        pot: Math.max(0, Number(nextAction
          ? Number(nextAction.pot || 0) - Number(nextAction.currentBetScore ?? nextAction.bet ?? 0)
          : replay.pot) || 0),
        board: board.slice(0, deal.cardCount),
      };
    });
    let nextDeal = 0;
    const timeline = [];
    for (const event of events) {
      while (nextDeal < deals.length && deals[nextDeal].gameState < Number(event.gameState)) {
        timeline.push(deals[nextDeal]);
        nextDeal += 1;
      }
      timeline.push(event);
    }
    timeline.push(...deals.slice(nextDeal));
    events = timeline;
  }
  events.forEach((event, index) => {
    if (!Number.isFinite(Number(event.replayOrder))) event.replayOrder = index;
  });
  let replayOrder = events.reduce((max, event) => Number.isFinite(Number(event.replayOrder))
    ? Math.max(max, Number(event.replayOrder)) : max, -1) + 1;
  players.forEach((player, index) => {
    if (!historyPlayerCanShowCards(player, forceShowCard)) return;
    const clientPlayer = historyPlayerForClient(player, index, forceShowCard);
    events.push({
      replayOrder: replayOrder++,
      uid: Number(player.uid),
      operationType: OP.SHOW,
      gameState: 11,
      pot: Number(replay.pot) || 0,
      cards: [...clientPlayer.showCards, ...clientPlayer.commonPoker],
    });
  });
  events.sort((a, b) => Number(a.replayOrder ?? 0) - Number(b.replayOrder ?? 0));
  const roomConfig = {
    maxPeople: Number(table.config?.maxPeople) || 7,
    roomType: Number(table.roomType),
    roomId: Number(table.roomId),
    dzpkParams: {
      smallBlind: Number(replay.smallBlind ?? table.smallBlind) || 0,
      bigBlind: Number(replay.bigBlind ?? table.bigBlind) || 0,
      initialBet: Number(replay.initialBet ?? table.bigBlind) || 0,
    },
  };
  const detail = {
    gameInningId: `${Number(table.roomId)}_${inning}`,
    gameRoomUnion: {
      gameRoomId: Number(table.roomId),
      roomId: Number(table.roomId),
      roomConfig: JSON.stringify(roomConfig),
    },
    inningResults: JSON.stringify(players.map((player, index) => {
      const clientPlayer = historyPlayerForClient(player, index, forceShowCard);
      const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
      const cardTypeInfo = player.cardTypeInfo || {};
      const result = {
        uid: clientPlayer.uid,
        userName: clientPlayer.userName,
        userIcon: clientPlayer.userIcon,
        posName: clientPlayer.posName,
        score: clientPlayer.score,
        isWin: clientPlayer.isWin,
        cardTypeId: clientPlayer.cardTypeId,
        // op=46 renders handPais beside commonPokerList. Unlike the settlement
        // best-five field, this detail field must contain only revealed holes.
        handPais: canShowCards ? clientPlayer.showCards.slice() : [],
        showCards: clientPlayer.showCards,
        cardTypePokers: clientPlayer.cardTypePokers,
        commonPokerList: clientPlayer.commonPoker,
        operateList: clientPlayer.operateList,
        winInsurance: Number(player.winInsurance) || 0,
        insuranceBet: Number(player.insuranceBet) || 0,
      };
      if (canShowCards) {
        result.cardTypeInfo = {
          cardTypeId: clientPlayer.cardTypeId,
          handCardList: clientPlayer.cardTypePokers.slice(),
          pokerEnumList: Array.isArray(cardTypeInfo.pokerEnumList) ? cardTypeInfo.pokerEnumList.slice() : [],
        };
      }
      return result;
    })),
    // HoldemHistoryModel.onPushRecordDetail parses this field unconditionally.
    inningInfo: JSON.stringify({ forceShowCard }),
    roundList: JSON.stringify(events.map((action) => {
      const cards = Array.isArray(action.cards) ? action.cards : [];
      const board = Array.isArray(action.board) ? action.board : cards.slice(2);
      return {
        uid: Number(action.uid) || 0,
        operationType: Number(action.operationType ?? action.operate) || 0,
        gameState: Number(action.gameState) || 0,
        bet: Number(action.bet) || 0,
        roundBetScore: Number(action.roundBetScore ?? action.bet) || 0,
        currentBetScore: Number(action.currentBetScore) || 0,
        totalBetScore: Number(action.totalBetScore) || 0,
        pot: Number(action.pot) || 0,
        flopPokerList: board.slice(0, 3),
        turnPoker: board[3] ?? -1,
        riverPoker: board[4] ?? -1,
        operationDuration: 1,
      };
    })),
    memberResults: players.map((player, pos) => {
      const clientPlayer = historyPlayerForClient(player, pos, forceShowCard);
      const canShowCards = historyPlayerCanShowCards(player, forceShowCard);
      return {
        uid: clientPlayer.uid,
        pos: Number.isInteger(player.pos) ? player.pos : pos,
        posName: clientPlayer.posName,
        pais: canShowCards ? clientPlayer.showCards.slice() : [],
        score: clientPlayer.score,
        point: Number(player.openingPoint) || 0,
        openingPoint: Number(player.openingPoint) || 0,
        userInfo: clientPlayer.userInfo,
      };
    }),
  };
  return { exploitsInfoMsgs: [detail] };
}

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
    gameRoomId: table.roomId,
    currentInningNum: table.currentInning,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
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
