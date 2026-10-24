import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import fs from "node:fs";
import { watchHot } from "../../hall/src/hot.js";
import { env, loadEnv } from "../../shared/rpc/env.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

function loadConfig() {
  const file = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : path.join(root, "hall/config.yaml");
  return yaml.load(fs.readFileSync(file, "utf8"));
}

async function main() {
  const config = loadConfig();
  loadEnv(config);
  const log = console;
  let app = (req, res) => {
    res.statusCode = 503;
    res.end("client-web loading");
  };

  async function apply(mod, version, reason) {
    app = mod.createClientApp();
    log.info(`[client-web] hot loaded v=${version} reason=${reason || "boot"}`);
  }

  const reload = watchHot({
    dir: here,
    extraDirs: env.isDev ? [path.resolve(here, "../../cache/client-web")] : [],
    entry: path.join(here, "app.js"),
    skip: (rel) => rel.endsWith("boot.js") || rel.endsWith(".test.js"),
    onReload: apply,
    log,
  });
  await reload("boot");

  const port = config.client_web_port || 4000;
  const host = config.server_ip || "0.0.0.0";
  const server = http.createServer((req, res) => app(req, res));
  await new Promise((resolve) => server.listen(port, host, resolve));
  log.info(`[client-web] listening http://${host}:${port}`);
  log.info(`[client-web] open http://localhost:${port}/`);

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
