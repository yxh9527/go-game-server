import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { rel } from "../../game-server/src/rel.js";
import { env } from "../../shared/rpc/env.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
const CLIENT_DEV_PATCH = env.isDev
  ? (await rel(import.meta.url, "../../cache/client-web/dev-patch.js", v)).CLIENT_DEV_PATCH
  : "";
const { adaptScratchMultiResponse } = await rel(import.meta.url, './scratch-multi-response.js', v);
const { adaptHoldemReplayResponse } = await rel(import.meta.url, './holdem-replay-response.js', v);
const { adaptPlayerPanelResponse } = await rel(import.meta.url, './player-panel-response.js', v);
const { adaptRoomUiResponse } = await rel(import.meta.url, './room-ui-response.js', v);
const { adaptHundredCleanupResponse } = await rel(import.meta.url, './hundred-cleanup-response.js', v);

const here = path.dirname(fileURLToPath(import.meta.url));
const staticRoot = path.resolve(here, "../../static");
const LANG_MODULES = ["common", "login", "server", "web", "payment"];

export function clientVersion() {
  const dir = path.join(staticRoot, "client");
  if (!fs.existsSync(dir)) {
    return "2.0.1279";
  }
  const names = fs.readdirSync(dir).filter((name) => /^\d+\.\d/.test(name)).sort();
  return names.at(-1) || "2.0.1279";
}

export function langModuleFiles(clientDir, name) {
  const dir = path.join(clientDir, "assets", `holdemGame_zh_cn_${name}`);
  if (!fs.existsSync(dir)) {
    return null;
  }
  const files = fs.readdirSync(dir);
  return {
    dir,
    config: files.find((file) => /^config\.[^.]+\.json$/.test(file)) || null,
    index: files.find((file) => /^index\.[^.]+\.js$/.test(file)) || null,
  };
}

function serveIndex(clientDir, res) {
  const file = path.join(clientDir, "index.html");
  let html = fs.readFileSync(file, "utf8");
  html = html.replace("<head>", `<head>${CLIENT_DEV_PATCH}`);
  res.set("Cache-Control", "no-store").type("html").send(html);
}

export function createClientApp() {
  const app = express();
  const version = clientVersion();
  const clientDir = path.join(staticRoot, "client", version);

  // Local resource overrides (for example x-switch redirects) retain the
  // original page's origin. These public assets need no cookies or credentials.
  if (env.isDev) app.use((req, res, next) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (req.method === "OPTIONS") {
      const headers = req.headers["access-control-request-headers"];
      if (headers) {
        res.set("Access-Control-Allow-Headers", headers);
        res.vary("Access-Control-Request-Headers");
      }
      res.status(204).end();
      return;
    }
    next();
  });

  app.use("/avator", express.static(path.join(staticRoot, "avator")));
  app.get(["/", `/${version}`, `/${version}/`, `/${version}/index.html`], (_req, res) => {
    serveIndex(clientDir, res);
  });
  app.get(`/${version}/js/webHallEarly.js`, (_req, res) => {
    res.set("Cache-Control", "no-store").type("application/javascript")
      .sendFile(path.join(clientDir, "js/webHallEarly.js"));
  });

  const mainDir=path.join(clientDir,'assets/main');
  if(fs.existsSync(mainDir))for(const name of fs.readdirSync(mainDir).filter(file=>/^index\.[^.]+\.js$/.test(file))){
    const file=path.join(mainDir,name);let modified=-1,adapted;
    app.get(['/'+version+'/assets/main/'+name,'/assets/main/'+name],(_req,res)=>{
      const current=fs.statSync(file).mtimeMs;
      if(current!==modified){adapted=adaptHundredCleanupResponse(adaptRoomUiResponse(adaptPlayerPanelResponse(adaptHoldemReplayResponse(fs.readFileSync(file,'utf8')))));modified=current;}
      res.set('Cache-Control','no-store').type('js').send(adapted);
    });
  }

  for(const bundle of ['Zjh','Qznn','Bairen','BairenMultyBet']){
    const bundleDir=path.join(clientDir,'assets',bundle);
    if(fs.existsSync(bundleDir))for(const name of fs.readdirSync(bundleDir).filter(file=>/^index\.[^.]+\.js$/.test(file))){
      const file=path.join(bundleDir,name);let modified=-1,adapted;
      app.get(['/'+version+'/assets/'+bundle+'/'+name,'/assets/'+bundle+'/'+name],(_req,res)=>{
        const current=fs.statSync(file).mtimeMs;
        if(current!==modified){adapted=adaptHundredCleanupResponse(adaptRoomUiResponse(fs.readFileSync(file,'utf8')));modified=current;}
        res.set('Cache-Control','no-store').type('js').send(adapted);
      });
    }
  }

  const multiDir = path.join(clientDir, 'assets/MultyBet');
  if (fs.existsSync(multiDir)) for (const name of fs.readdirSync(multiDir).filter(file => /^index\.[^.]+\.js$/.test(file))) {
    const file = path.join(multiDir, name);
    let modified = -1, adapted;
    app.get([`/${version}/assets/MultyBet/${name}`, `/assets/MultyBet/${name}`], (_req, res) => {
      const current = fs.statSync(file).mtimeMs;
      if (current !== modified) {
        adapted = adaptScratchMultiResponse(fs.readFileSync(file, 'utf8'));
        modified = current;
      }
      res.set('Cache-Control', 'no-store').type('js').send(adapted);
    });
  }

  for (const name of LANG_MODULES) {
    const files = langModuleFiles(clientDir, name);
    if (!files) {
      continue;
    }
    if (files.config) {
      const configPath = path.join(files.dir, files.config);
      app.get(`/${version}/assets/${name}/config.json`, (_req, res) => {
        res.set("Cache-Control", "no-store").sendFile(configPath);
      });
    }
    if (files.index) {
      const indexPath = path.join(files.dir, files.index);
      app.get(`/${version}/assets/${name}/index.js`, (_req, res) => {
        res.set("Cache-Control", "no-store").type("application/javascript").sendFile(indexPath);
      });
    }
    app.use(`/${version}/assets/${name}`, express.static(files.dir));
  }

  app.use(`/${version}`, express.static(clientDir));
  app.use(express.static(clientDir));
  return app;
}
