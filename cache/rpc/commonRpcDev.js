import { addUserGold, getUserGold, initUserGold } from "./sharedState.js";

export class CommonRpcDev {
  async getBalance(userId) {
    return getUserGold(userId);
  }

  debit(userId, amount) {
    initUserGold(userId);
    return addUserGold(userId, -Math.abs(Number(amount) || 0));
  }

  credit(userId, amount) {
    initUserGold(userId);
    return addUserGold(userId, Math.abs(Number(amount) || 0));
  }
}
