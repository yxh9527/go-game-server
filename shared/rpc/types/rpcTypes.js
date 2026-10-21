/**
 * @typedef {object} AuthResult
 * @property {boolean} success
 * @property {number} userId
 * @property {boolean} isReEnter
 * @property {string} [message]
 */

/**
 * @typedef {object} LoginProfile
 * @property {number} userId
 * @property {string} userName
 * @property {number} agentId
 * @property {number} topAgentId
 * @property {number} [walletAmount]
 */

/**
 * GatewayRpcService
 * authenticate / getLoginData / validateToken
 *
 * CommonRpcService
 * getBalance / debit / credit
 *
 * LobbyRpcService
 * listRooms / listMatches / getMatch / insertMatch / updateMatch / countUnusedTickets / ...
 *
 * BusRpcService
 * publish / subscribe / close
 */
export const ModuleType = {
  gateway: "gateway",
  common: "common",
  lobby: "lobby",
  bus: "bus",
};
