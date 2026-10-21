import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { closeRpc, env, initRpc } from "../../shared/rpc/index.js";
import { createRpcWallet } from "../../game-server/src/wallet/rpcWallet.js";
import { attachGameProxy } from "./game-proxy.js";
import { isGameStaticHost, isHallApiPath, proxyToClientWeb } from "./static-proxy.js";
import { watchHot } from "./hot.js";
import { createMatchStore, createRoomStore } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const REDIS_CHANNEL_MATCH = "match";

function loadConfig() {
  const file = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : path.join(root, "config.yaml");
  return yaml.load(fs.readFileSync(file, "utf8"));
}

async function loadSnapshot(runtime) {
  const matches = await runtime.rpc.lobby.listMatches();
  const rooms = await runtime.rpc.lobby.listRooms();
  let players = [];
  let tables = [];
  try {
    players = await runtime.rpc.lobby.listMatchPlayers();
  } catch (err) {
    runtime.log.error("load match players skipped", err.message);
  }
  try {
    tables = await runtime.rpc.lobby.listMatchRooms();
  } catch (err) {
    runtime.log.error("load match rooms skipped", err.message);
  }
  runtime.matchStore.replaceMatches(matches);
  runtime.matchStore.replacePlayers(players);
  runtime.matchStore.replaceTables(tables);
  runtime.roomStore.replace(rooms);
}

async function main() {
  const config = loadConfig();
  const log = console;
  const rpc = await initRpc(config, log);
  const matchStore = createMatchStore();
  const roomStore = createRoomStore();
  const runtime = {
    config,
    log,
    hotVersion: 0,
    matchStore,
    roomStore,
    rpc,
    wallet: createRpcWallet(rpc),
    store: rpc.lobby,
    bus: rpc.bus,
    gateway: rpc.gateway,
    env: env.isDev ? "dev" : "prod",
  };

  await loadSnapshot(runtime);
  rpc.bus.subscribe(REDIS_CHANNEL_MATCH, (message) => {
    matchStore.applyEnvelope(message);
  });

  let app = (req, res) => {
    res.statusCode = 503;
    res.end("hall loading");
  };
  const clientWeb = config.client_web || `127.0.0.1:${config.client_web_port || 4000}`;
  const server = http.createServer((req, res) => {
    if (env.isDev && isGameStaticHost(req.headers.host) && !isHallApiPath(req.url)) {
      proxyToClientWeb(req, res, clientWeb, log);
      return;
    }
    app(req, res);
  });
  if (env.isDev) {
    attachGameProxy(server, config.game_server || "127.0.0.1:11041", log);
  }

  async function apply(mod, version, reason) {
    runtime.hotVersion = version;
    try {
      roomStore.replace(await rpc.lobby.listRooms());
    } catch (err) {
      log.error("reload rooms failed", err);
    }
    const next = await mod.createApp(runtime);
    app = next;
    log.info(`[hall] hot loaded v=${version} reason=${reason || "boot"} matches=${matchStore.listMatches().length}`);
  }

  const reload = watchHot({
    dir: here,
    entry: path.join(here, "create-app.js"),
    skip: (rel) => rel.endsWith("boot.js") || rel.endsWith(".test.js") || rel.endsWith("hot.js") || rel.endsWith("store.js") || rel.endsWith("game-proxy.js") || rel.endsWith("static-proxy.js"),
    onReload: apply,
    log,
  });
  await reload("boot");

  const port = config.server_port || 11042;
  const host = config.server_ip || "0.0.0.0";
  await new Promise((resolve) => server.listen(port, host, resolve));
  log.info(`[hall] listening http://${host}:${port} env=${runtime.env}`);
  if (env.isDev) {
    log.info(`[hall] open http://lobby.localhost:${port}/21/0?userId=10001&userToken=dev&openId=10001&v=2.0.1279`);
  }

  const shutdown = async () => {
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
