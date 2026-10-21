import { RpcAdapter } from "./adapters/rpcAdapter.js";
import { env, loadEnv } from "./env.js";
import { prodDeps, setProdDeps } from "./implementations/prod/prodDeps.js";

/**
 * 统一 RPC 入口，对齐 fgServer `core/rpc`。
 * 先 loadEnv，再 new RpcAdapter；业务只拿 gateway / common / lobby / bus。
 */
export let rpcService = null;

export async function initRpc(config = {}, log = console) {
  loadEnv(config);
  if (!env.isDev) {
    const mysqlMod = await import("mysql2/promise");
    const mysql = mysqlMod.default || mysqlMod;
    const manager = mysql.createPool({
      host: config.mysql.manager.host,
      port: config.mysql.manager.port,
      user: config.mysql.manager.user,
      password: config.mysql.manager.password,
      database: config.mysql.manager.database,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    });
    const player = mysql.createPool({
      host: config.mysql.player.host,
      port: config.mysql.player.port,
      user: config.mysql.player.user,
      password: config.mysql.player.password,
      database: config.mysql.player.database,
      waitForConnections: true,
      connectionLimit: 10,
      charset: "utf8mb4",
    });
    const Redis = (await import("ioredis")).default;
    const [host, port] = String(config.redis?.host?.[0] || "127.0.0.1:6379").split(":");
    const redis = new Redis({
      host,
      port: Number(port || 6379),
      username: config.redis?.user || undefined,
      password: config.redis?.pwd || undefined,
    });
    setProdDeps({ manager, player, redis });
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
  try {
    await prodDeps.manager?.end?.();
  } catch {
    /* ignore */
  }
  try {
    await prodDeps.player?.end?.();
  } catch {
    /* ignore */
  }
  setProdDeps({ manager: null, player: null, redis: null });
  rpcService = null;
}

export { env, loadEnv, RpcAdapter };
export * from "./types/rpcTypes.js";
