import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { clientVersion, browserEndpoints, browserSocketDomain } from "../../shared/client-version.js";
import { env } from "../../shared/rpc/env.js";
import { rel } from "./rel.js";

export { clientVersion };

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const roomListRefresh = await rel(import.meta.url, "./room-list-refresh.js", version);
export const HALL_DEV_PATCH = env.isDev
  ? (await rel(import.meta.url, "../../cache/hall/dev-patch.js", version)).HALL_DEV_PATCH
  : "";

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, "../../static");

export function publicWsHost(req, config, env) {
  const endpoint = browserEndpoints(config).game_ws_url;
  if (endpoint) return browserSocketDomain(endpoint);
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

export function publicHundredWsHost(req, config, env) {
  const endpoint = browserEndpoints(config).hundred_ws_url;
  if (endpoint) return browserSocketDomain(endpoint);
  if (env === "dev" && req) {
    // Native SocketMgr suppresses RoomSocket2 when both public hosts match.
    // The existing dev WS proxy accepts both names on the same listener.
    const domain = publicWsHost(req, config, env);
    return domain.replace(/^www\./, "hundred.");
  }
  return config.hundred_server || config.game_server || "";
}

function hallTemplate() {
  return fs.readFileSync(path.join(staticRoot, "hall/21/0/index.html"), "utf8");
}

function isHallPath(gameType, subGameType) {
  return /^\d+$/.test(String(gameType || "")) && /^-?\d+$/.test(String(subGameType || ""));
}

export function withLoginQuery(url, version) {
  const u = new URL(url, "http://lobby.localhost");
  // open-api owns the issued credential. Native clients read userToken;
  // overwrite a stale/dev alias rather than let the two fields disagree.
  const issuedToken = u.searchParams.get("token");
  if (issuedToken) u.searchParams.set("userToken", issuedToken);
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
  const endpoints = browserEndpoints(runtime.config);
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
    if (!endpoints.hall_url && (hostname === "localhost" || hostname === "127.0.0.1")) {
      const dest = withLoginQuery(req.originalUrl === "/" ? hallEntry : req.originalUrl, version);
      res.redirect(302, `http://lobby.localhost:${port}${dest}`);
      return;
    }
    next();
  });

  app.get("/", (_req, res) => {
    res.redirect(302, (endpoints.hall_url || '') + withLoginQuery(hallEntry + (_req.url.includes('?') ? _req.url.slice(_req.url.indexOf('?')) : ''), version));
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
    if (!req.query.userToken || !req.query.v || !req.query.openId
      || req.query.token && req.query.userToken !== req.query.token) {
      res.redirect(302, withLoginQuery(req.originalUrl, version));
      return;
    }
    renderHall(req, res);
  });

  // Apply the current hall's common polling adapter to the served response,
  // without editing the original static bundle or changing protocol fields.
  const chunks = path.join(staticRoot, "hall/_next/static/chunks");
  if (endpoints.client_url) {
    const pages = path.join(chunks, 'pages');
    for (const name of fs.readdirSync(pages).filter(name => /^_app[-.].*\.js$/.test(name))) {
      const file = path.join(pages, name);
      let modified = -1, adapted;
      app.get('/_next/static/chunks/pages/' + name, (_req, res) => {
        const current = fs.statSync(file).mtimeMs;
        if (modified !== current) {
          adapted = adaptClientOrigin(fs.readFileSync(file, 'utf8'), endpoints.client_url);
          modified = current;
        }
        res.set('Cache-Control', 'no-store').type('js').send(adapted);
      });
    }
  }
  if (fs.existsSync(chunks)) {
    const bundles = fs.readdirSync(chunks).filter(name => /^434[.-][a-f0-9]+\.js$/.test(name));
    for (const name of bundles) {
      const filename = path.join(chunks, name);
      let modified = fs.statSync(filename).mtimeMs;
      let adapted = roomListRefresh.adaptRoomListRefresh(fs.readFileSync(filename, "utf8"));
      app.get("/_next/static/chunks/" + name, (_req, res) => {
        const current = fs.statSync(filename).mtimeMs;
        if (current !== modified) {
          adapted = roomListRefresh.adaptRoomListRefresh(fs.readFileSync(filename, "utf8"));
          modified = current;
        }
        res.set("Cache-Control", "no-store").type("js").send(adapted);
      });
    }
  }
  app.use("/_next", express.static(path.join(staticRoot, "hall/_next")));
  app.use("/l01", express.static(path.join(staticRoot, "hall/l01")));
  app.use("/avator", express.static(path.join(staticRoot, "avator")));
}

export function adaptClientOrigin(source, origin) {
  const original = 'let n=new URL("localhost"===window.location.hostname?"https://lobby-h5.yezoc.xyz":window.location.origin),r=n.hostname.split(".");r[0]="www",n.hostname=r.join(".");let a=n.origin';
  if (!source.includes(original)) throw new Error('Hall iframe URL adapter does not match the current _app bundle');
  return source.replace(original, `let n=new URL(${JSON.stringify(origin).replaceAll('<', '\\u003c')});let a=n.origin`);
}
