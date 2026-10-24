import { env } from "../env.js";
import { createRequire } from "node:module";
import { BusRpcProd } from "../implementations/prod/busRpcProd.js";
import { CommonRpcProd } from "../implementations/prod/commonRpcProd.js";
import { GatewayRpcProd } from "../implementations/prod/gatewayRpcProd.js";
import { LobbyRpcProd } from "../implementations/prod/lobbyRpcProd.js";
const require = createRequire(import.meta.url);

/**
 * 统一 RPC 入口。
 * 业务代码只依赖 adapter，不再直接 new 某个 dev/prod 实现。
 */
export class RpcAdapter {
  constructor() {
    this.initializeServices();
  }

  initializeServices() {
    if (env.isDev) {
      // Node 22 loads synchronous ESM here only in dev. Production can omit cache entirely.
      const { BusRpcDev } = require("../../../cache/rpc/busRpcDev.js");
      const { CommonRpcDev } = require("../../../cache/rpc/commonRpcDev.js");
      const { GatewayRpcDev } = require("../../../cache/rpc/gatewayRpcDev.js");
      const { LobbyRpcDev } = require("../../../cache/rpc/lobbyRpcDev.js");
      this.gatewayService = new GatewayRpcDev();
      this.commonService = new CommonRpcDev();
      this.lobbyService = new LobbyRpcDev();
      this.busService = new BusRpcDev();
      return;
    }
    this.gatewayService = new GatewayRpcProd();
    this.commonService = new CommonRpcProd();
    this.lobbyService = new LobbyRpcProd();
    this.busService = new BusRpcProd();
  }

  get gateway() {
    return this.gatewayService;
  }

  get common() {
    return this.commonService;
  }

  get lobby() {
    return this.lobbyService;
  }

  get bus() {
    return this.busService;
  }

  getService(moduleType) {
    switch (moduleType) {
      case "gateway":
        return this.gatewayService;
      case "common":
        return this.commonService;
      case "lobby":
        return this.lobbyService;
      case "bus":
        return this.busService;
      default:
        throw new Error(`Unknown rpc module type: ${moduleType}`);
    }
  }
}
