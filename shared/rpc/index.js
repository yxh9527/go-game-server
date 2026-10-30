import { RpcAdapter } from "./adapters/rpcAdapter.js";
import { env, loadEnv } from "./env.js";
import { prodDeps, setProdDeps } from "./implementations/prod/prodDeps.js";
import { closeGogameStorageClient } from './utils/gogameStorageGrpc.js';
import { closeDataCenterClient } from './utils/dataCenterGrpc.js';

/**
 * 统一 RPC 入口，对齐 fgServer `core/rpc`。
 * 先 loadEnv，再 new RpcAdapter；业务只拿 gateway / common / lobby / bus。
 */
export let rpcService = null;

export async function initRpc(config = {}, log = console) {
  loadEnv(config);
  if (!env.isDev) {
    const Redis = (await import("ioredis")).default;
    const [host, port] = String(config.redis?.host?.[0] || "127.0.0.1:6379").split(":");
    const redis = new Redis({
      host,
      port: Number(port || 6379),
      username: config.redis?.user || undefined,
      password: config.redis?.pwd || undefined,
    });
    setProdDeps({ redis });
    log.info?.("[rpc] env=prod GatewayRpcProd/CommonRpcProd/LobbyRpcProd");
  } else {
    log.info?.("[rpc] env=dev GatewayRpcDev/CommonRpcDev/LobbyRpcDev, memory only");
  }
  rpcService = new RpcAdapter();
  return rpcService;
}

export async function closeRpc() {
  await rpcService?.bus?.close?.();
  try {
    prodDeps.redis?.disconnect?.();
  } catch {
    /* ignore */
  }
  closeGogameStorageClient();
  closeDataCenterClient();
  setProdDeps({ redis: null });
  rpcService = null;
}

export { env, loadEnv, RpcAdapter };
export * from "./types/rpcTypes.js";
