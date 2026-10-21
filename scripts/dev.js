import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const services = [
  { name: "match", file: "match/src/boot.js", color: "36" },
  { name: "game-server", file: "game-server/src/boot.js", color: "33" },
  { name: "client-web", file: "client-web/src/boot.js", color: "35" },
  { name: "hall", file: "hall/src/boot.js", color: "32" },
];

function ensureLocalHosts() {
  const hostsPath = process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts")
    : "/etc/hosts";
  const needed = ["lobby.localhost", "www.localhost"];
  try {
    const current = fs.readFileSync(hostsPath, "utf8");
    const missing = needed.filter((name) => !current.split(/\r?\n/).some((line) => line.includes(name) && !line.trim().startsWith("#")));
    if (!missing.length) {
      return;
    }
    fs.appendFileSync(hostsPath, `\n${missing.map((name) => `127.0.0.1 ${name}`).join("\n")}\n`);
    console.log(`已写入 hosts: ${missing.join(", ")}`);
  } catch {
    console.log("请把下面两行加进 hosts（Windows 需要管理员）：");
    console.log("  127.0.0.1 lobby.localhost");
    console.log("  127.0.0.1 www.localhost");
  }
}

ensureLocalHosts();

const children = [];

function prefix(name, color, chunk, stream) {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (line.length) {
      stream.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);
    }
  }
}

for (const svc of services) {
  const child = spawn(process.execPath, [svc.file], {
    cwd: root,
    env: { ...process.env, GOGAME_ENV: "dev", IS_DEV: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => prefix(svc.name, svc.color, data, process.stdout));
  child.stderr.on("data", (data) => prefix(svc.name, svc.color, data, process.stderr));
  child.on("exit", (code) => {
    process.stdout.write(`[${svc.name}] exit ${code}\n`);
  });
  children.push(child);
}

function shutdown() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("dev 模式（内存，不连 data-center / MySQL / Redis）");
console.log("浏览器打开：");
console.log("  大厅 http://lobby.localhost:11042/21/0?userId=10001&userToken=dev&openId=10001&v=2.0.1279");
console.log("  游戏静态站 http://localhost:4000/  （iframe 走 www.localhost:11042 → 转发到 4000）");
console.log("进德州：大厅里点「德州」");
