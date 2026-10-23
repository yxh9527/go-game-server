import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientVersion, createClientApp, langModuleFiles } from "./app.js";
import { CLIENT_DEV_PATCH } from "./dev-patch.js";

test("client version reads static/client", () => {
  assert.equal(clientVersion(), "2.0.1279");
});

test("langModuleFiles finds hashed common bundle files", () => {
  const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../static/client/2.0.1279");
  const files = langModuleFiles(clientDir, "common");
  assert.ok(files);
  assert.equal(files.config, "config.cc744.json");
  assert.equal(files.index, "index.cc744.js");
});

test("client app serves local avatar files by avatar ID", async () => {
  const server = http.createServer(createClientApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/avator/90007.png`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^image\/png/);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("client dev patch remaps language bundles and keeps console", () => {
  assert.match(CLIENT_DEV_PATCH, /holdemGame_/);
  assert.match(CLIENT_DEV_PATCH, /keepConsole/);
  assert.match(CLIENT_DEV_PATCH, /force webHallOb/);
  assert.match(CLIENT_DEV_PATCH, /installBundle/);
  assert.match(CLIENT_DEV_PATCH, /mappedBundle/);
  assert.match(CLIENT_DEV_PATCH, /flushOpenGame|deliver handleOpenGame/);
  assert.match(CLIENT_DEV_PATCH, /rewriteAssetUrl/);
  assert.match(CLIENT_DEV_PATCH, /peekOpenGame/);
  assert.match(CLIENT_DEV_PATCH, /findHandleOpenGame|getClassByName/);
  assert.match(CLIENT_DEV_PATCH, /capture openGame/);
  assert.match(CLIENT_DEV_PATCH, /scene\.name === "webHallOb"/);
  assert.match(CLIENT_DEV_PATCH, /WebHallOb\.start|afterStart/);
  assert.match(CLIENT_DEV_PATCH, /post gameLoaded/);
  assert.match(CLIENT_DEV_PATCH, /loadScene/);
  assert.match(CLIENT_DEV_PATCH, /loadSceneDirect/);
  assert.match(CLIENT_DEV_PATCH, /runSceneImmediate/);
  assert.match(CLIENT_DEV_PATCH, /api\\.pansu\\.xyz/);
  assert.match(CLIENT_DEV_PATCH, /lobby\.localhost/);
  assert.match(CLIENT_DEV_PATCH, /hide persist|hideBairenOverlay/);
  assert.match(CLIENT_DEV_PATCH, /addPersistRootNode/);
  assert.match(CLIENT_DEV_PATCH, /_persistRootNodes/);
  assert.match(CLIENT_DEV_PATCH, /loadedSends/);
  assert.match(CLIENT_DEV_PATCH, /persist hook/);
  assert.match(CLIENT_DEV_PATCH, /hide launch overlay/);
  assert.match(CLIENT_DEV_PATCH, /launchOverlayHidden/);
  assert.match(CLIENT_DEV_PATCH, /launch-new-api/);
  assert.match(CLIENT_DEV_PATCH, /function isLoadingPersist/);
  assert.match(CLIENT_DEV_PATCH, /skip hundred cleanup without hundredDomain/);
  assert.match(CLIENT_DEV_PATCH, /connectTips/);
  assert.match(CLIENT_DEV_PATCH, /hideConnectTips|isLoadingPersist/);
  assert.match(CLIENT_DEV_PATCH, /joinRoom\.isOb = true/);
  assert.match(CLIENT_DEV_PATCH, /scheduleHoldemScene/);
  assert.match(CLIENT_DEV_PATCH, /scene already active/);
  assert.match(CLIENT_DEV_PATCH, /skip duplicate scene/);
  assert.match(CLIENT_DEV_PATCH, /sceneReady/);
  assert.match(CLIENT_DEV_PATCH, /GameCanvas/);
  assert.match(CLIENT_DEV_PATCH, /pointerEvents/);
  assert.doesNotMatch(CLIENT_DEV_PATCH, /canvas\.style\.position/);
  assert.doesNotMatch(CLIENT_DEV_PATCH, /freezeMutedNode|__gogameFrozen|pauseSystemEvents/);
  assert.match(CLIENT_DEV_PATCH, /showLoading hook|block showLoading|GameUtils showLoading hook/);
  assert.match(CLIENT_DEV_PATCH, /__gogameLaunchObs/);
});

test("hundred-game cleanup does not block ordinary room exit without a hundred domain", async () => {
  const intervalCallbacks = [];
  let cleanupCalls = 0;
  class BairenMultyBetViewModel {
    sendUnregRoomsReq() {
      cleanupCalls += 1;
      return Promise.reject(new Error("当前没有hundredDomain百人服地址, 无法连接百人服"));
    }
  }
  const classes = { BairenMultyBetViewModel };
  const cc = {
    js: { getClassByName: (name) => classes[name] || null, _nameToClass: classes },
    assetManager: { bundles: { forEach() {} } },
    director: { getScene: () => ({ name: "webHallOb" }) },
  };
  const window = {
    cc,
    location: { href: "http://www.localhost:11042/2.0.1279/?userId=10001&openId=10001&isWebHall=1" },
    parent: { postMessage() {} },
    WebSocket: class WebSocket {},
    addEventListener() {},
  };
  const context = {
    window,
    cc,
    location: window.location,
    document: { documentElement: {}, getElementById: () => null },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    XMLHttpRequest: class XMLHttpRequest { open() {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearInterval() {},
    setTimeout: () => 1,
  };
  const patch = CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");

  vm.runInNewContext(patch, context);
  for (const callback of intervalCallbacks) callback();
  await BairenMultyBetViewModel.prototype.sendUnregRoomsReq();

  assert.equal(cleanupCalls, 1);
});

test("Holdem patch leaves game nodes and their input events untouched", () => {
  const intervalCallbacks = [];
  const bairenMultyBet = { name: "BairenMultyBet", active: true, pauseSystemEvents() { this.paused = true; } };
  const buttonLayer = { name: "bairen_root", active: true, pauseSystemEvents() { this.paused = true; } };
  const loading = { name: "ProgressLoading", active: true, pauseSystemEvents() { this.paused = true; } };
  const activeScene = { name: "gameHoldem", _children: [] };
  const roots = { a: bairenMultyBet, b: buttonLayer, c: loading };
  const cc = {
    app: {},
    game: { _persistRootNodes: roots, addPersistRootNode() {} },
    js: { getClassByName: () => null, _nameToClass: {} },
    assetManager: { bundles: { forEach() {} } },
    director: { getScene: () => activeScene },
  };
  const window = {
    cc,
    location: { href: "http://www.localhost:11042/2.0.1279/?userId=10001&openId=10001&isWebHall=1" },
    parent: { postMessage() {} },
    WebSocket: class WebSocket {},
    addEventListener() {},
  };
  const context = {
    window,
    cc,
    location: window.location,
    document: { documentElement: {}, getElementById: () => null },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    XMLHttpRequest: class XMLHttpRequest { open() {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearInterval() {},
    setTimeout: () => 1,
  };
  const patch = CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");

  vm.runInNewContext(patch, context);
  for (const callback of intervalCallbacks) callback();

  assert.equal(bairenMultyBet.active, true);
  assert.equal(buttonLayer.active, true);
  assert.equal(bairenMultyBet.paused, undefined);
  assert.equal(buttonLayer.paused, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(bairenMultyBet, "active").get, undefined);
  assert.equal(loading.active, false);
  assert.equal(loading.paused, undefined);
  assert.equal(typeof cc.app.webImgPool, "object");
});

test("webHallEarly exposes peek without consuming cache", () => {
  const src = fs.readFileSync(new URL("../../static/client/2.0.1279/js/webHallEarly.js", import.meta.url), "utf8");
  assert.match(src, /function peek\(/);
  assert.match(src, /take: take, peek: peek/);
});

test("direct scene fallback skips a scene that the client entered while loading", () => {
  let activeScene = { name: "webHallOb" };
  let loadSceneCalls = 0;
  let runSceneImmediateCalls = 0;
  const loadedMessages = [];
  const gameScene = { name: "gameHoldem" };
  const bundle = {
    loadScene(_name, _progress, complete) {
      loadSceneCalls += 1;
      activeScene = gameScene;
      complete(null, gameScene);
    },
  };
  const cc = {
    js: { getClassByName: () => null, _nameToClass: {} },
    assetManager: { getBundle: () => bundle, bundles: { forEach() {} } },
    director: {
      getScene: () => activeScene,
      runSceneImmediate() {
        runSceneImmediateCalls += 1;
      },
    },
  };
  const window = {
    cc,
    location: { href: "http://www.localhost:11042/2.0.1279/?userId=10001&openId=10001&isWebHall=1" },
    parent: { postMessage(message) { loadedMessages.push(message); } },
    WebSocket: class WebSocket {},
    addEventListener() {},
  };
  const context = {
    window,
    cc,
    location: window.location,
    document: { getElementById: () => null },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    XMLHttpRequest: class XMLHttpRequest { open() {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: () => 1,
  };
  const patch = CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");

  vm.runInNewContext(patch, context);
  context.console.warn("进入游戏", "gameHoldem");

  assert.equal(loadSceneCalls, 1);
  assert.equal(activeScene.name, "gameHoldem");
  assert.equal(runSceneImmediateCalls, 0);
  assert.equal(loadedMessages.filter((message) => message.type === "gameLoaded").length, 1);
});

test("runtime SceneManager module is preferred over the direct scene fallback", async () => {
  let activeScene = { name: "webHallOb" };
  let loadSceneCalls = 0;
  let runSceneCalls = 0;
  const loadedMessages = [];
  const gameScene = { name: "gameHoldem" };
  const sceneManager = {
    currentOptions: { module: "", scene: "" },
    loadScene(options) {
      loadSceneCalls += 1;
      assert.equal(options.module, "Holdem");
      assert.equal(options.scene, "gameHoldem");
      return Promise.resolve({ sceneAsset: gameScene, options });
    },
    runScene(pack) {
      runSceneCalls += 1;
      activeScene = pack.sceneAsset;
      this.currentOptions = pack.options;
      return Promise.resolve();
    },
  };
  const cc = {
    js: { getClassByName: () => null, _nameToClass: {} },
    assetManager: { getBundle: () => null, bundles: { forEach() {} } },
    director: { getScene: () => activeScene },
  };
  const window = {
    cc,
    __require(name) {
      assert.equal(name, "SceneManager");
      return { default: { instance: sceneManager } };
    },
    location: { href: "http://www.localhost:11042/2.0.1279/?userId=10001&openId=10001&isWebHall=1" },
    parent: { postMessage(message) { loadedMessages.push(message); } },
    WebSocket: class WebSocket {},
    addEventListener() {},
  };
  const context = {
    window,
    cc,
    location: window.location,
    document: { getElementById: () => null },
    history: { replaceState() {} },
    URL,
    URLSearchParams,
    XMLHttpRequest: class XMLHttpRequest { open() {} },
    console: { log() {}, warn() {}, error() {} },
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (fn) => { fn(); return 1; },
  };
  const patch = CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");

  vm.runInNewContext(patch, context);
  context.console.warn("进入游戏", "gameHoldem");
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(loadSceneCalls, 1);
  assert.equal(runSceneCalls, 1);
  assert.equal(activeScene.name, "gameHoldem");
  assert.ok(loadedMessages.filter((message) => message.type === "gameLoaded").length >= 1);
});
