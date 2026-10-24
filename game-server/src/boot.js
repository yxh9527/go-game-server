import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { WebSocketServer } from "ws";
import { closeRpc, env, initRpc } from "../../shared/rpc/index.js";
import { watchHot } from "./hot.js";
import { createRegistry, findConfig } from "./registry.js";
import { createRpcWallet } from "./wallet/rpcWallet.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function loadConfig() {
  const file = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : path.join(root, "config.yaml");
  return yaml.load(fs.readFileSync(file, "utf8"));
}

async function main() {
  const config = loadConfig();
  const log = console;
  const rpc = await initRpc(config, log);
  const registry = createRegistry();
  const runtime = {
    config,
    log,
    registry,
    findConfig,
    configs: [],
    hotVersion: 0,
    rpc,
    wallet: createRpcWallet(rpc),
    store: rpc.lobby,
    bus: rpc.bus,
    gateway: rpc.gateway,
    env: env.isDev ? "dev" : "prod",
  };

  try {
    runtime.configs = await rpc.lobby.listRooms();
  } catch (err) {
    log.error("load room config failed", err.message);
  }

  let handler = {
    async onMessage() {},
    tick() {},
  };

  async function apply(mod, version, reason) {
    runtime.hotVersion = version;
    try {
      runtime.configs = await rpc.lobby.listRooms();
    } catch (err) {
      log.error("reload room config failed", err.message);
    }
    handler = await mod.createHandler(runtime);
    runtime.getDevHoldemRecordDetail = handler.getDevHoldemRecordDetail;
    log.info(`[game-server] hot loaded v=${version} reason=${reason || "boot"}`);
  }

  const reload = watchHot({
    dir: here,
    extraDirs: env.isDev ? [path.resolve(here, "../../cache/holdem"), path.resolve(here, "../../cache/game-server")] : [],
    entry: path.join(here, "create-handler.js"),
    skip: (rel) => rel.endsWith("boot.js") || rel.endsWith(".test.js") || rel.endsWith("hot.js") || rel.endsWith("registry.js"),
    onReload: apply,
    log,
  });
  await reload("boot");

  const server = http.createServer((req, res) => {
    if (handler.handleLocalRequest?.(req, res)) return;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      code: 0,
      msg: "ok",
      data: {
        service: "game-server",
        env: runtime.env,
        hotVersion: runtime.hotVersion,
        tables: runtime.registry.tables.size,
        wallet: runtime.wallet.mode,
      },
    }));
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      Promise.resolve(handler.onMessage(ws, data)).catch((err) => log.error(err));
    });
    ws.on("close", () => {
      Promise.resolve(handler.onClose?.(ws)).catch((err) => log.error(err));
    });
  });

  setInterval(() => {
    try {
      handler.tick();
    } catch (err) {
      log.error(err);
    }
  }, 1000);

  const port = config.server_port || 11041;
  const host = config.server_ip || "0.0.0.0";
  await new Promise((resolve) => server.listen(port, host, resolve));
  log.info(`[game-server] listening ws://${host}:${port} env=${runtime.env}`);

  const shutdown = async () => {
    wss.close();
    server.close();
    await closeRpc();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
