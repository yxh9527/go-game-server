export function createMatchStore() {
  const matches = new Map();
  const players = new Map();
  const tables = new Map();

  function playerKey(matchId, playerId) {
    return `${matchId}:${playerId}`;
  }

  return {
    replaceMatches(rows) {
      matches.clear();
      for (const row of rows || []) {
        matches.set(Number(row.id), row);
      }
    },
    replacePlayers(rows) {
      players.clear();
      for (const row of rows || []) {
        players.set(playerKey(row.match_id, row.player_id), row);
      }
    },
    replaceTables(rows) {
      tables.clear();
      for (const row of rows || []) {
        const id = Number(row.match_id);
        const list = tables.get(id) || [];
        list.push(row);
        tables.set(id, list);
      }
    },
    upsertMatch(row) {
      if (!row || row.id == null) {
        return;
      }
      matches.set(Number(row.id), row);
    },
    getMatch(id) {
      return matches.get(Number(id)) || null;
    },
    listMatches() {
      return [...matches.values()];
    },
    getPlayer(matchId, playerId) {
      return players.get(playerKey(matchId, playerId)) || null;
    },
    getTables(matchId) {
      return tables.get(Number(matchId)) || [];
    },
    applyEnvelope(raw) {
      let env;
      try {
        env = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        return;
      }
      if (!env || !env.event) {
        return;
      }
      let data = env.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (env.event === "match_upsert" || env.event === "match_state") {
        this.upsertMatch(data);
      }
      if (env.event === "match_sign" && data) {
        if (data.match_id != null && data.player_id != null) {
          players.set(playerKey(data.match_id, data.player_id), data);
        }
        if (data.id != null && data.championship_name != null) {
          this.upsertMatch(data);
        }
      }
    },
  };
}

export function createRoomStore() {
  let rooms = [];
  return {
    replace(rows) {
      rooms = rows || [];
    },
    list() {
      return rooms;
    },
  };
}
