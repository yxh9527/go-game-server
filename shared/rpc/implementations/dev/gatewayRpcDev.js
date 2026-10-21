import { bindDevToken, getUserGold, initUserGold, validateDevToken } from "./sharedState.js";

export class GatewayRpcDev {
  async authenticate(token, userId) {
    const uid = Number(userId) || 10001;
    const bound = bindDevToken(token, uid);
    if (!bound.ok) {
      return { success: false, userId: 0, isReEnter: false, message: "token bound to another user" };
    }
    initUserGold(uid);
    return { success: true, userId: uid, isReEnter: bound.isReEnter, message: "dev auth success" };
  }

  async getLoginData(userId) {
    const uid = Number(userId) || 0;
    initUserGold(uid);
    return {
      userId: uid,
      userName: `dev-${uid}`,
      agentId: 1,
      topAgentId: 1,
      walletAmount: getUserGold(uid),
    };
  }

  async validateToken(token, userId) {
    return validateDevToken(token, userId);
  }
}
