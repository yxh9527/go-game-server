import { getDataCenterClient } from "../../utils/dataCenterGrpc.js";

export class GatewayRpcProd {
  async authenticate(token, userId) {
    const client = await getDataCenterClient();
    const resp = await client.authenticate({
      token: String(token || ""),
      gameId: 0,
      entryUserId: Number(userId) || 0,
    });
    return {
      success: Boolean(resp.success),
      userId: Number(resp.userId || 0),
      isReEnter: Boolean(resp.isReEnter),
      message: resp.message || "",
    };
  }

  async getLoginData(userId) {
    const client = await getDataCenterClient();
    const resp = await client.getLoginData({ userId: Number(userId) || 0 });
    const profile = resp.profile || {};
    return {
      userId: Number(profile.userId || userId || 0),
      userName: profile.userName || "",
      agentId: Number(profile.agentId || 0),
      topAgentId: Number(profile.topAgentId || 0),
      walletAmount: 0,
    };
  }

  async validateToken(token, userId) {
    const client = await getDataCenterClient();
    const resp = await client.validateToken({
      token: String(token || ""),
      userId: Number(userId) || 0,
    });
    return Boolean(resp.valid);
  }

  async getRecords(query = {}) {
    const client = await getDataCenterClient();
    return client.getRecords({
      UserId: Number(query.userId) || 0,
      Symbol: String(query.symbol || ""),
      Hash: String(query.hash || ""),
      Currency: String(query.currency || ""),
      GameId: Number(query.gameId) || 0,
      StartTime: Number(query.startTime) || 0,
      EndTime: Number(query.endTime) || 0,
      Page: Math.max(1, Number(query.page) || 1),
      Size: Math.min(100, Math.max(1, Number(query.size) || 20)),
    });
  }

  async getRecordDetail(query = {}) {
    const client = await getDataCenterClient();
    return client.getRecordDetail({
      recordId: String(query.recordId || ""),
      userId: Number(query.userId) || 0,
      gameId: Number(query.gameId) || 0,
    });
  }
}
