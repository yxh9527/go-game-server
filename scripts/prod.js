import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const services = new Set(["hall", "game-server", "match", "client-web"]);
const [service, ...args] = process.argv.slice(2);
if (!services.has(service)) throw new Error("Usage: node scripts/prod.js hall|game-server|match|client-web [--config path]");
const child = spawn(process.execPath, [path.join(root, service, "src/boot.js"), ...args], {
  cwd: root,
  env: { ...process.env, NODE_ENV: "production", GOGAME_ENV: "prod", IS_DEV: "0" },
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
