// Existing empty replay response for environments without a replay provider.
export function emptyHistoryPayload(table, request = {}) {
  return {
    excellentGame: Boolean(request.excellentGame),
    isOfflineData: false,
    smallBlind: table.smallBlind,
    bigBlind: table.bigBlind,
    initialBet: table.bigBlind,
    beginNum: 0,
    endNum: 0,
    totalNum: 0,
    roomTypeName: "dzpk",
    blind: JSON.stringify({ smallBlind: table.smallBlind, bigBlind: table.bigBlind, initialBet: table.bigBlind, isStraddle: false }),
    gameRoomId: table.roomId,
    playBackList: [],
  };
}
