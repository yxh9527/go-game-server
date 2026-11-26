import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import fs from "node:fs";
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
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

function workerCount(config) {
  const value = config.client_web_workers ?? 'auto';
  if (value === 'auto') return Math.min(4, availableParallelism());
  if (!Number.isInteger(value) || value < 1 || value > 64) {
    throw new Error('client_web_workers must be auto or an integer from 1 to 64');
  }
  return value;
}

function startCluster(count) {
  // Explicit round-robin also applies on Windows, where the default differs.
  cluster.schedulingPolicy = cluster.SCHED_RR;
  let stopping = false, exitCode = 0, shutdownTimer;
  const timers = new Set();
  function finish() {
    if (!stopping || Object.keys(cluster.workers).length) return;
    clearTimeout(shutdownTimer);
    process.exit(exitCode);
  }
  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const worker of Object.values(cluster.workers)) {
      if (worker.isConnected()) worker.send({ type: 'client-web:shutdown' }, () => {});
      else worker.kill();
    }
    shutdownTimer = setTimeout(() => {
      for (const worker of Object.values(cluster.workers)) worker.kill('SIGKILL');
    }, 12000);
    shutdownTimer.unref();
    finish();
  }
  function fork(slot, failures = 0) {
    const started = Date.now();
    const worker = cluster.fork();
    console.log(`[client-web] worker starting slot=${slot} pid=${worker.process.pid}`);
    worker.on('error', error => console.error(`[client-web] worker pid=${worker.process.pid}`, error.message));
    worker.on('listening', address => {
      console.log(`[client-web] worker ready slot=${slot} pid=${worker.process.pid} port=${address.port}`);
    });
    worker.on('exit', (code, signal) => {
      if (stopping) { finish(); return; }
      const nextFailures = Date.now() - started > 30000 ? 1 : failures + 1;
      console.error(`[client-web] worker exited slot=${slot} pid=${worker.process.pid} code=${code} signal=${signal}`);
      if (nextFailures >= 5) {
        console.error('[client-web] repeated worker failures; stopping cluster (check port, config and startup errors)');
        shutdown(1);
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!stopping) fork(slot, nextFailures);
      }, Math.min(500 * 2 ** (nextFailures - 1), 5000));
      timers.add(timer);
    });
  }
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());
  process.on('message', message => { if (message?.type === 'client-web:shutdown') shutdown(); });
  process.on('disconnect', () => shutdown());
  console.log(`[client-web] primary pid=${process.pid} workers=${count}; all workers share one listening port`);
  for (let slot = 1; slot <= count; slot++) fork(slot);
}

async function main(config) {
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
    extraDirs: [path.resolve(here,'../../shared'),...(env.isDev ? [path.resolve(here, "../../cache/client-web")] : [])],
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

  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    // Drain current HTTP requests, then release hot-update watchers with exit.
    server.close(() => process.exit(0));
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 10000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on('message', message => { if (message?.type === 'client-web:shutdown') shutdown(); });
  if (cluster.isWorker) process.on('disconnect', shutdown);
}

async function start() {
  const config = loadConfig();
  const count = workerCount(config);
  if (cluster.isPrimary && count > 1) startCluster(count);
  else await main(config);
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
