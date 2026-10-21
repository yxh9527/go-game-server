import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";
import { prodDeps } from "./prodDeps.js";

export class CommonRpcProd {
  async getBalance(userId) {
    const client = await getDataCenterClient();
    const resp = await client.getPlayer({ PlayerId: Number(userId) || 0, Factory: 0 });
    const player = resp.HumanPlayer || resp.humanPlayer || {};
    return Number(player.GameCurrency || player.gameCurrency || 0);
  }

  debit(_userId, _amount) {
    return { ok: true };
  }

  credit(_userId, _amount) {
    return { ok: true };
  }

  async persistScore(userId, score) {
    const db = prodDeps.player;
    if (!db || !userId || userId >= 90000000) {
      return;
    }
    await db.query("UPDATE user_info SET score=? WHERE user_id=?", [score, userId]);
  }
}
