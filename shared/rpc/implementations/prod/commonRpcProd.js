import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";

function unavailable() {
  throw Object.assign(new Error('Authoritative wallet mutations are not configured'), { code: 'WALLET_UNAVAILABLE' });
}

export class CommonRpcProd {
  async getBalance(userId) {
    const client = await getDataCenterClient();
    const resp = await client.getPlayer({ PlayerId: Number(userId) || 0, Factory: 0 });
    const player = resp.HumanPlayer || resp.humanPlayer || {};
    return Number(player.GameCurrency || player.gameCurrency || 0);
  }

  debit(_userId, _amount) {
    return unavailable();
  }

  credit(_userId, _amount) {
    return unavailable();
  }

  async persistScore(userId, score) {
    // Never overwrite the authoritative balance with a connection snapshot.
    return unavailable();
  }
}
