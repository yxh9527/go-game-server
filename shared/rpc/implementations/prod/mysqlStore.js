export function createMysqlStore({ manager, player }) {
  return {
    async listRooms() {
      const [rows] = await manager.query("SELECT * FROM gg_room_config WHERE state=1");
      return rows;
    },
    async listMatches() {
      const [rows] = await manager.query("SELECT * FROM gg_match ORDER BY sort_index ASC, id DESC");
      return rows;
    },
    async getMatch(id) {
      const [rows] = await manager.query("SELECT * FROM gg_match WHERE id=?", [id]);
      return rows[0] || null;
    },
    async insertMatch(row) {
      const keys = Object.keys(row);
      const sql = `INSERT INTO gg_match (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`;
      const [ret] = await manager.query(sql, keys.map((k) => row[k]));
      return this.getMatch(ret.insertId);
    },
    async updateMatch(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) {
        return this.getMatch(id);
      }
      const sql = `UPDATE gg_match SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`;
      await manager.query(sql, [...keys.map((k) => patch[k]), id]);
      return this.getMatch(id);
    },
    async getAward(id) {
      const [rows] = await manager.query("SELECT * FROM gg_award_template WHERE id=?", [id]);
      return rows[0] || null;
    },
    async listTickets() {
      const [rows] = await manager.query("SELECT * FROM gg_ticket ORDER BY id ASC");
      return rows;
    },
    async insertTicket(row) {
      const [ret] = await manager.query(
        "INSERT INTO gg_ticket (name,price,currency,match_id,num,remain,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
        [row.name, row.price, row.currency, row.match_id, row.num, row.remain, row.create_time, row.update_time],
      );
      const [rows] = await manager.query("SELECT * FROM gg_ticket WHERE id=?", [ret.insertId]);
      return rows[0];
    },
    async updateTicket(id, patch) {
      await manager.query(
        "UPDATE gg_ticket SET name=?, price=?, currency=?, match_id=?, num=?, remain=?, update_time=? WHERE id=?",
        [patch.name, patch.price, patch.currency, patch.match_id, patch.num, patch.remain, patch.update_time, id],
      );
      const [rows] = await manager.query("SELECT * FROM gg_ticket WHERE id=?", [id]);
      return rows[0] || null;
    },
    async listRates() {
      const [rows] = await manager.query("SELECT * FROM gg_ticket_currency_rate ORDER BY id ASC");
      return rows;
    },
    async upsertRate(row) {
      const [found] = await manager.query("SELECT * FROM gg_ticket_currency_rate WHERE currency=?", [row.currency]);
      if (!found.length) {
        const [ret] = await manager.query(
          "INSERT INTO gg_ticket_currency_rate (currency,rate,create_time,update_time) VALUES (?,?,?,?)",
          [row.currency, row.rate, row.create_time, row.update_time],
        );
        const [rows] = await manager.query("SELECT * FROM gg_ticket_currency_rate WHERE id=?", [ret.insertId]);
        return rows[0];
      }
      await manager.query("UPDATE gg_ticket_currency_rate SET rate=?, update_time=? WHERE id=?", [row.rate, row.update_time, found[0].id]);
      const [rows] = await manager.query("SELECT * FROM gg_ticket_currency_rate WHERE id=?", [found[0].id]);
      return rows[0];
    },
    async listAwards() {
      const [rows] = await manager.query("SELECT * FROM gg_award_template ORDER BY id ASC");
      return rows;
    },
    async insertAward(row) {
      const [ret] = await manager.query(
        "INSERT INTO gg_award_template (name,detail,create_time,update_time) VALUES (?,?,?,?)",
        [row.name, row.detail, row.create_time, row.update_time],
      );
      const [rows] = await manager.query("SELECT * FROM gg_award_template WHERE id=?", [ret.insertId]);
      return rows[0];
    },
    async updateAward(id, patch) {
      await manager.query("UPDATE gg_award_template SET name=?, detail=?, update_time=? WHERE id=?", [patch.name, patch.detail, patch.update_time, id]);
      const [rows] = await manager.query("SELECT * FROM gg_award_template WHERE id=?", [id]);
      return rows[0] || null;
    },
    async listBlinds() {
      const [rows] = await manager.query("SELECT * FROM gg_blinds ORDER BY id ASC");
      return rows;
    },
    async insertBlinds(row) {
      const [ret] = await manager.query(
        "INSERT INTO gg_blinds (name,data,create_time,update_time) VALUES (?,?,?,?)",
        [row.name, row.data, row.create_time, row.update_time],
      );
      const [rows] = await manager.query("SELECT * FROM gg_blinds WHERE id=?", [ret.insertId]);
      return rows[0];
    },
    async updateBlinds(id, patch) {
      await manager.query("UPDATE gg_blinds SET name=?, data=?, update_time=? WHERE id=?", [patch.name, patch.data, patch.update_time, id]);
      const [rows] = await manager.query("SELECT * FROM gg_blinds WHERE id=?", [id]);
      return rows[0] || null;
    },
    async listMatchPlayers() {
      if (!player) {
        return [];
      }
      const [rows] = await player.query("SELECT * FROM gg_match_player");
      return rows;
    },
    async listMatchRooms() {
      if (!player) {
        return [];
      }
      const [rows] = await player.query("SELECT * FROM gg_match_room");
      return rows;
    },
    async countUnusedTickets(userId) {
      if (!player || !userId) {
        return 0;
      }
      const [rows] = await player.query(
        "SELECT COUNT(*) AS n FROM gg_ticket_hold WHERE owner=? AND is_use=0",
        [userId],
      );
      return Number(rows[0]?.n || 0);
    },
  };
}
