import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { clientVersion } from "../../client-web/src/app.js";

export { clientVersion };

export const HALL_DEV_PATCH = `<script>
(function () {
  var ready = false;
  var returnedToHall = false;
  var VIS = "game-iframe_visible__LsoiQ";
  var FRAME_HOST = '[class*="gameIframe"]';
  function gameFrames() {
    return document.querySelectorAll(FRAME_HOST + ' iframe');
  }
  function isGameMessage(ev) {
    var frames = gameFrames();
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].contentWindow === ev.source) return true;
    }
    return false;
  }
  function setImportantStyle(el, name, value) {
    if (!el || !el.style) return;
    if (el.style.getPropertyValue(name) === value && el.style.getPropertyPriority(name) === "important") return;
    el.style.setProperty(name, value, "important");
  }
  function showIframe() {
    var nodes = document.querySelectorAll(FRAME_HOST);
    for (var i = 0; i < nodes.length; i++) {
      if (!nodes[i].classList.contains(VIS)) nodes[i].classList.add(VIS);
      setImportantStyle(nodes[i], "visibility", "visible");
      setImportantStyle(nodes[i], "pointer-events", "auto");
      setImportantStyle(nodes[i], "z-index", "10001");
    }
    var frames = gameFrames();
    for (var j = 0; j < frames.length; j++) {
      setImportantStyle(frames[j], "visibility", "visible");
      setImportantStyle(frames[j], "pointer-events", "auto");
    }
  }
  function hideIframe() {
    var nodes = document.querySelectorAll(FRAME_HOST);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].classList.contains(VIS)) nodes[i].classList.remove(VIS);
      setImportantStyle(nodes[i], "visibility", "hidden");
      setImportantStyle(nodes[i], "pointer-events", "none");
      setImportantStyle(nodes[i], "z-index", "-1");
    }
    var frames = gameFrames();
    for (var j = 0; j < frames.length; j++) {
      setImportantStyle(frames[j], "visibility", "hidden");
      setImportantStyle(frames[j], "pointer-events", "none");
    }
  }
  function restoreLoading() {
    var nodes = document.querySelectorAll('[class*="loading_loading"]');
    for (var i = 0; i < nodes.length; i++) {
      var names = ["display", "visibility", "pointer-events", "z-index"];
      for (var j = 0; j < names.length; j++) nodes[i].style.removeProperty(names[j]);
    }
  }
  function hideLoading() {
    try {
      if (typeof window.$loading === "function") window.$loading(false);
    } catch (e) {}
    var nodes = document.querySelectorAll('[class*="loading_loading"]');
    for (var i = 0; i < nodes.length; i++) {
      setImportantStyle(nodes[i], "display", "none");
      setImportantStyle(nodes[i], "visibility", "hidden");
      setImportantStyle(nodes[i], "pointer-events", "none");
      setImportantStyle(nodes[i], "z-index", "-1");
    }
  }
  function onLoaded() {
    if (!ready) console.log("[GOGAME-HALL] gameLoaded overlay off");
    ready = true;
    returnedToHall = false;
    hideLoading();
    showIframe();
  }
  window.addEventListener("message", function (ev) {
    if (!isGameMessage(ev)) return;
    var data = ev && ev.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    if (data && data.type === "gameLoaded") {
      onLoaded();
      // Official hall does router.push("/game") on gameLoaded, which remounts
      // the iframe and drops the already-running holdem scene.
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
    } else if (data && data.type === "gameBack" && (ready || returnedToHall)) {
      // We kept the original hall route on gameLoaded, so router.back() would
      // leave that hall. Release its iframe overlay and stay on this route.
      ready = false;
      returnedToHall = true;
      hideLoading();
      hideIframe();
      if (ev.stopImmediatePropagation) ev.stopImmediatePropagation();
      console.log("[GOGAME-HALL] gameBack restore hall");
    } else if (data && data.type === "errText") {
      ready = false;
      returnedToHall = true;
      hideIframe();
      // Keep the original hall error/toast handling.
    }
  }, true);
  var tries = 0;
  var timer = setInterval(function () {
    if (typeof window.$loading === "function" && !window.$loading.__gogame) {
      var orig = window.$loading;
      window.$loading = function (on) {
        if (ready) on = false;
        else if (on) restoreLoading();
        return orig.call(this, on);
      };
      window.$loading.__gogame = true;
    }
    if (ready) {
      hideLoading();
      showIframe();
    } else if (returnedToHall) {
      hideIframe();
    }
    if (++tries > 400) clearInterval(timer);
  }, 100);
  try {
    var obs = new MutationObserver(function () {
      if (ready) {
        hideLoading();
        showIframe();
      } else if (returnedToHall) {
        hideIframe();
      }
    });
    // Do not watch style: the sync below writes styles. Class changes are
    // needed because React can remount the iframe shell without replacing it.
    obs.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  } catch (e) {}
})();
</script>`;

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, "../../static");

export function publicWsHost(req, config, env) {
  if (env === "dev" && req) {
    const host = String(req.headers.host || "lobby.localhost:11042");
    const [name, port] = host.split(":");
    if (name === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(name)) {
      return `www.localhost${port ? `:${port}` : ""}`;
    }
    const labels = name.split(".");
    labels[0] = "www";
    return `${labels.join(".")}${port ? `:${port}` : ""}`;
  }
  return config.game_server || "";
}

function hallTemplate() {
  return fs.readFileSync(path.join(staticRoot, "hall/21/0/index.html"), "utf8");
}

function isHallPath(gameType, subGameType) {
  return /^\d+$/.test(String(gameType || "")) && /^-?\d+$/.test(String(subGameType || ""));
}

export function withLoginQuery(url, version) {
  const u = new URL(url, "http://lobby.localhost");
  if (!u.searchParams.get("userToken")) {
    u.searchParams.set("userId", u.searchParams.get("userId") || "10001");
    u.searchParams.set("userToken", "dev");
  }
  if (!u.searchParams.get("userId")) {
    u.searchParams.set("userId", "10001");
  }
  // Captured Cocos GameUtils.isApi() requires apiData.openId. Without it the
  // iframe stays on launch and never consumes openGame.
  if (!u.searchParams.get("openId")) {
    u.searchParams.set("openId", u.searchParams.get("userId") || "10001");
  }
  if (!u.searchParams.get("isOb")) {
    u.searchParams.set("isOb", "false");
  }
  if (!u.searchParams.get("v")) {
    u.searchParams.set("v", version);
  }
  return `${u.pathname}${u.search}`;
}

export function mountWeb(app, runtime) {
  const version = clientVersion();
  const port = runtime.config.server_port || 11042;
  const template = hallTemplate();
  const hallEntry = `/21/0`;

  function renderHall(_req, res) {
    let html = template;
    if (html.indexOf("GOGAME-HALL") < 0) {
      html = html.replace("<head>", `<head>${HALL_DEV_PATCH}`);
    }
    res.set("Cache-Control", "no-store").type("html").send(html);
  }

  app.use((req, res, next) => {
    const hostname = String(req.headers.host || "").split(":")[0];
    if (hostname === "localhost" || hostname === "127.0.0.1") {
      const dest = withLoginQuery(req.originalUrl === "/" ? hallEntry : req.originalUrl, version);
      res.redirect(302, `http://lobby.localhost:${port}${dest}`);
      return;
    }
    next();
  });

  app.get("/", (_req, res) => {
    res.redirect(302, withLoginQuery(hallEntry, version));
  });

  app.get(["/game", "/:ver/game"], (req, res, next) => {
    if (req.params.ver && !/^\d+\.\d[\d.]*$/.test(req.params.ver) && req.params.ver !== "game") {
      next();
      return;
    }
    const q = new URLSearchParams(req.query).toString();
    res.redirect(302, withLoginQuery(`${hallEntry}${q ? `?${q}` : ""}`, version));
  });

  app.get("/_next/data/:buildId/game.json", (_req, res) => {
    res.json({ pageProps: {}, __N_SSG: true });
  });

  app.get("/:version/:gameType/:subGameType", (req, res, next) => {
    if (!/^\d+\.\d[\d.]*$/.test(req.params.version) || !isHallPath(req.params.gameType, req.params.subGameType)) {
      next();
      return;
    }
    const q = new URLSearchParams(req.query);
    q.set("v", q.get("v") || req.params.version);
    res.redirect(302, withLoginQuery(`/${req.params.gameType}/${req.params.subGameType}?${q.toString()}`, version));
  });

  app.get("/:gameType/:subGameType", (req, res, next) => {
    if (!isHallPath(req.params.gameType, req.params.subGameType)) {
      next();
      return;
    }
    if (req.params.gameType !== "21" || req.params.subGameType !== "0") {
      res.redirect(302, withLoginQuery(`${hallEntry}${req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""}`, version));
      return;
    }
    if (!req.query.userToken || !req.query.v || !req.query.openId) {
      res.redirect(302, withLoginQuery(req.originalUrl, version));
      return;
    }
    renderHall(req, res);
  });

  app.use("/_next", express.static(path.join(staticRoot, "hall/_next")));
  app.use("/l01", express.static(path.join(staticRoot, "hall/l01")));
  app.use("/avator", express.static(path.join(staticRoot, "avator")));
}
