export function createRegistry() {
  const tables = new Map();
  const sessions = new Map();

  return {
    tables,
    sessions,
    getTable(roomId) {
      return tables.get(Number(roomId)) || null;
    },
    setTable(roomId, table) {
      tables.set(Number(roomId), table);
      return table;
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
