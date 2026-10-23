export function createRegistry() {
  const tables = new Map();
  const sessions = new Map();
  const roomManager = new Map();

  const keyOf = (agentId, gameId, roomId) => `${Number(agentId) || 0}:${String(gameId || "unknown")}:${Number(roomId) || 0}`;
  function resolveTable(roomId, agentId, gameId) {
    if (agentId != null && gameId != null) return tables.get(keyOf(agentId, gameId, roomId)) || null;
    if (agentId != null) {
      const suffix = `:${Number(roomId) || 0}`;
      for (const [key, table] of tables) if (key.startsWith(`${Number(agentId) || 0}:`) && key.endsWith(suffix)) return table;
      return null;
    }
    const suffix = `:${Number(roomId) || 0}`;
    for (const [key, table] of tables) if (key.endsWith(suffix)) return table;
    return null;
  }

  function addToRoomManager(table) {
    const agentId = Number(table.agentId) || 0;
    const gameId = String(table.gameId || "unknown");
    let games = roomManager.get(agentId);
    if (!games) {
      games = new Map();
      roomManager.set(agentId, games);
    }
    let rooms = games.get(gameId);
    if (!rooms) {
      rooms = new Map();
      games.set(gameId, rooms);
    }
    rooms.set(Number(table.roomId), table);
  }

  function removeFromRoomManager(table) {
    const agentId = Number(table.agentId) || 0;
    const games = roomManager.get(agentId);
    const rooms = games?.get(String(table.gameId || "unknown"));
    rooms?.delete(Number(table.roomId));
    if (rooms && rooms.size === 0) games.delete(String(table.gameId || "unknown"));
    if (games && games.size === 0) roomManager.delete(agentId);
  }

  return {
    tables,
    sessions,
    roomManager,
    getTable(roomId, agentId, gameId) {
      return resolveTable(roomId, agentId, gameId);
    },
    setTable(roomId, table, agentId, gameId) {
      if (agentId != null) table.agentId = Number(agentId) || 0;
      if (gameId != null) table.gameId = gameId;
      const key = keyOf(table.agentId, table.gameId, roomId);
      const previous = tables.get(key);
      if (previous) removeFromRoomManager(previous);
      tables.set(key, table);
      addToRoomManager(table);
      return table;
    },
    removeTable(roomId, agentId, gameId) {
      const table = resolveTable(roomId, agentId, gameId);
      if (!table) return null;
      tables.delete(keyOf(table.agentId, table.gameId, roomId));
      removeFromRoomManager(table);
      return table;
    },
    listAgentGameRooms(agentId, gameId) {
      const games = roomManager.get(Number(agentId) || 0);
      if (gameId != null) return [...(games?.get(String(gameId))?.values() || [])];
      return [...(games?.values() || [])].flatMap((rooms) => [...rooms.values()]);
    },
    findRoom(agentId, gameId, roomId) {
      return roomManager.get(Number(agentId) || 0)?.get(String(gameId))?.get(Number(roomId)) || null;
    },
    listByRoomType(roomType) {
      return [...tables.values()].filter((item) => Number(item.roomType) === Number(roomType));
    },
    bind(ws, session) {
      sessions.set(ws, session);
      return session;
    },
    session(ws) {
      return sessions.get(ws) || null;
    },
    drop(ws) {
      const session = sessions.get(ws);
      sessions.delete(ws);
      return session;
    },
  };
}

export function findConfig(configs, roomId, roomType) {
  const id = Number(roomId);
  const cfgId = Math.floor(id / 10000);
  const roomIndex = id % 10000;
  return (configs || []).find((row) => Number(row.game_room_config_id) === cfgId && Number(row.room_index) === roomIndex)
    || (configs || []).find((row) => Number(row.game_room_config_id) === cfgId)
    || (configs || []).find((row) => Number(row.room_type) === Number(roomType))
    || null;
}
