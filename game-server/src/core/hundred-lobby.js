// Public hall cards reuse the game's visibility rules, never the raw hand.
const PUBLIC_FIELDS = ['state', 'inning', 'countDown', 'ways', 'boardTypeStats',
  'showdownPokers', 'showdownTypes', 'dealPokers', 'bankerCards', 'playerCards',
  'defaultOuter', 'defaultInner', 'outerIndex', 'innerIndex', 'outerValue', 'innerValue',
  'winningAreas', 'lostAreas', 'tieAreas', 'consecutiveWinCounts', 'areaOdds', 'goodRoadInfo'];

export function hundredLobbySnapshot(game, table, now = Date.now()) {
  const snapshot = game.enterSnapshot(table, { userId: 0, wallet: 0 });
  const remaining = Number(table.phaseEndsAt) - now;
  const countDown = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
  const info = { roomId: table.roomId, roomType: table.roomType, playMode: table.playMode };
  for (const field of PUBLIC_FIELDS) if (snapshot[field] !== undefined) info[field] = snapshot[field];
  info.countDown = countDown;
  if (table.roomType >= 53 && table.roomType <= 57 && info.ways?.[2]) {
    // Room roads use result objects; the native hall reads combined IDs 1..12.
    info.ways = { ...info.ways, 2: { ...info.ways[2], ways: info.ways[2].ways.map(result =>
      typeof result === 'number' ? result : (result.innerValue - 1) * 4 + result.outerValue) } };
  }
  return {
    gameRoomConfigId: Number(table.cfg.game_room_config_id), roomType: Number(table.roomType),
    roomIndex: Number(table.cfg.room_index || 0), roomId: Number(table.roomId),
    gameStatus: Number.isFinite(Number(snapshot.state)) ? Number(snapshot.state) : 0, gameStatusStartTime: now,
    gameStatusDuration: countDown, serverNow: now,
    ...(Number(table.roomType) === 58 && table.playMode === 4 ? { vipTableData: {
      bg: table.baccaratOwnerSettings?.bg || 1, dealer: table.baccaratOwnerSettings?.dealer || 223,
      ...(table.baccaratOwner ? { hostUid: table.baccaratOwner.uid } : {}),
    } } : {}),
    extendInfo: JSON.stringify(info),
  };
}

export function listHundredLobbyRooms(runtime, gameOf, agentId, selection = {}) {
  const now = Date.now();
  return (runtime.configs || []).filter(row => Number(row.state ?? 1) === 1
    && (selection.gameType == null || Number(row.game_type) === Number(selection.gameType))
    && (selection.roomType == null || Number(row.room_type) === Number(selection.roomType)))
    .flatMap(row => {
      const game = gameOf(Number(row.room_type));
      if (game?.kind !== 'hundred') return [];
      const roomId = Number(row.game_room_config_id) * 10000 + Number(row.room_index || 0);
      const table = runtime.registry.getTable(roomId, agentId, game.id);
      if (table) return [hundredLobbySnapshot(game, table, now)];
      // Configuration-only preview: reading the hall must not start a game,
      // allocate a live room, shuffle a shoe or register a visitor.
      const rules = game.rulesForRoom?.(row, game.config);
      const info = { roomId, roomType: Number(row.room_type), playMode: Number(row.play_mode || 0),
        state: 0, countDown: 0, ways: game.config.initialWays?.() || { 1: { ways: [] }, 2: { ways: [] } } };
      if (rules?.defaultOuter) info.defaultOuter = rules.defaultOuter.slice();
      if (rules?.defaultInner) info.defaultInner = rules.defaultInner.slice();
      return [{ gameRoomConfigId: Number(row.game_room_config_id), roomType: Number(row.room_type),
        roomIndex: Number(row.room_index || 0), roomId, gameStatus: 0,
        gameStatusStartTime: now, gameStatusDuration: 0, serverNow: now, extendInfo: JSON.stringify(info) }];
    });
}
