import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HALL_DEV_PATCH } from "../../hall/src/web.js";

// Isolated UI regression with the original CSS. Does not access live rooms,
// user accounts or an existing browser profile. Pass a Chromium executable.
const executable = process.argv[2];
if (!executable) throw new Error("Pass the Chrome/Chromium executable path");
const css = fs.readFileSync(new URL("../../static/hall/_next/static/css/e72075e8ded8af30.css", import.meta.url), "utf8");
function browserCheck() {
  const report = { checks: [], backCalls: 0 };
  const holder = document.querySelector(".game-iframe_gameIframe__blCWg");
  const frame = holder.querySelector("iframe");
  const delay = () => new Promise((resolve) => setTimeout(resolve, 100));
  const check = (name, ok) => report.checks.push({ name, ok });
  window.addEventListener("message", (event) => {
    if (event.source === frame.contentWindow && event.data.type === "gameBack") report.backCalls++;
  });
  window.$loading = () => {};
  (async () => {
    await new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
    await delay();
    for (let cycle = 0; cycle < 2; cycle++) {
      frame.contentWindow.postMessage("gameLoaded", "*");
      await delay();
      check("game visible " + cycle, getComputedStyle(holder).visibility === "visible" && document.elementFromPoint(100, 100) === frame);
      frame.contentWindow.postMessage("gameBack", "*");
      await delay();
      check("hall visible " + cycle, getComputedStyle(holder).visibility === "hidden" && document.elementFromPoint(100, 100).id === "hall");
      holder.classList.add("game-iframe_visible__LsoiQ");
      await delay();
      check("stays in hall after rerender " + cycle, getComputedStyle(holder).visibility === "hidden" && document.elementFromPoint(100, 100).id === "hall");
    }
    check("no unrelated history back", report.backCalls === 0);
    document.getElementById("result").textContent = JSON.stringify(report);
  })().catch((error) => { document.getElementById("result").textContent = JSON.stringify({ error: String(error) }); });
}
const child = '<body style="margin:0;background:black"><script>addEventListener("message",event=>parent.postMessage({type:event.data},"*"))</script></body>';
const html = '<!doctype html><html><head>' + HALL_DEV_PATCH + '<style>' + css
  + ' #hall{position:fixed;inset:0;background:white} #result{position:fixed;top:400px}</style></head>'
  + '<body><div id="hall">HALL</div><div class="game-iframe_gameIframe__blCWg"><iframe src="/child"></iframe></div>'
  + '<pre id="result">pending</pre><script>(' + browserCheck.toString() + ')();</script></body></html>';
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(req.url === "/child" ? child : html);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "gogame-hall-return-"));
try {
  const browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-gpu",
    "--user-data-dir=" + profile, "--dump-dom", "--virtual-time-budget=4000",
    "http://127.0.0.1:" + server.address().port], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "";
  browser.stdout.on("data", (data) => { output += data; });
  browser.stderr.on("data", (data) => { errors += data; });
  const timer = setTimeout(() => browser.kill(), 20000);
  let exit;
  try { exit = await new Promise((resolve, reject) => { browser.on("exit", resolve); browser.on("error", reject); }); }
  finally { clearTimeout(timer); }
  const result = output.match(/<pre id="result">([\s\S]*?)<\/pre>/)?.[1];
  console.log(JSON.stringify({ exit, result, diagnostics: result ? undefined : errors.slice(-1800), profile }));
  if (!result || result === "pending" || !JSON.parse(result).checks?.every((row) => row.ok)) process.exitCode = 1;
} finally {
  server.close();
}
