import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { closeRpc, env, initRpc } from "../../shared/rpc/index.js";
import { watchHot } from "./hot.js";

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
  const runtime = {
    config,
    log,
    hotVersion: 0,
    rpc,
    store: rpc.lobby,
    bus: rpc.bus,
    env: env.isDev ? "dev" : "prod",
  };

  let app = (req, res) => {
    res.statusCode = 503;
    res.end("match loading");
  };
  const server = http.createServer((req, res) => app(req, res));
  const addr = `${config.server_ip || "0.0.0.0"}:${config.server_port || 11040}`;

  async function apply(mod, version, reason) {
    runtime.hotVersion = version;
    const next = await mod.createApp(runtime);
    app = next;
    log.info(`[match] hot loaded v=${version} reason=${reason || "boot"}`);
  }

  const reload = watchHot({
    dir: here,
    entry: path.join(here, "create-app.js"),
    skip: (rel) => rel.endsWith("boot.js") || rel.endsWith(".test.js") || rel.endsWith("hot.js"),
    onReload: apply,
    log,
  });
  await reload("boot");

  await new Promise((resolve) => server.listen(config.server_port || 11040, config.server_ip || "0.0.0.0", resolve));
  log.info(`[match] listening ${addr} env=${runtime.env}`);

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
