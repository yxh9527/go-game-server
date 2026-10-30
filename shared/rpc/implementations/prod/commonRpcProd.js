import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";
import { getGogameStorageClient } from '../../utils/gogameStorageGrpc.js';

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
    if (!userId || userId >= 90000000) {
      return;
    }
    const client=await getGogameStorageClient();
    await client.call('persistScore',{userId:Number(userId),score});
  }
}
