import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";
import { getGogameStorageClient } from '../../utils/gogameStorageGrpc.js';

function unavailable() {
  throw Object.assign(new Error('Authoritative wallet mutations are not configured'), { code: 'WALLET_UNAVAILABLE' });
}

export function currencyToScore(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error('Invalid authoritative currency balance');
  const score = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'));
  if (score > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Balance exceeds safe score range');
  return Number(score);
}

export class CommonRpcProd {
  async cashRead(account) {
    return (await getGogameStorageClient()).call('cashRead', account);
  }
  async cashApply(request) {
    return (await getGogameStorageClient()).call('cashApply', request);
  }
  async getBalance(userId) {
    const client = await getDataCenterClient();
    const resp = await client.getPlayer({ PlayerId: Number(userId) || 0, Factory: 0 });
    const player = resp.HumanPlayer || resp.humanPlayer || {};
    return currencyToScore(player.GameCurrency ?? player.gameCurrency);
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
