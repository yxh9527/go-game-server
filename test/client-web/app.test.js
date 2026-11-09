import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clientVersion, createClientApp, langModuleFiles } from "../../client-web/src/app.js";
import { CLIENT_DEV_PATCH } from "../../cache/client-web/dev-patch.js";
import {adaptHoldemReplayResponse} from '../../client-web/src/holdem-replay-response.js';
import {adaptPlayerPanelResponse} from '../../client-web/src/player-panel-response.js';
import {adaptRoomUiResponse} from '../../client-web/src/room-ui-response.js';
import {adaptHundredCleanupResponse} from '../../client-web/src/hundred-cleanup-response.js';

test('main script serves the spectator replay fix at both routes without rewriting original static assets',async()=>{
  const file=new URL('../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url);
  const original=fs.readFileSync(file,'utf8'),expected=adaptHundredCleanupResponse(adaptRoomUiResponse(adaptPlayerPanelResponse(adaptHoldemReplayResponse(original))));
  assert.notEqual(expected,original);assert.equal(adaptHoldemReplayResponse(expected),expected);
  assert.equal(adaptHoldemReplayResponse('unrelated bundle'),'unrelated bundle');
  const server=http.createServer(createClientApp());await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const route of ['/2.0.1279/assets/main/index.88f4e.js','/assets/main/index.88f4e.js']){
      const response=await fetch('http://127.0.0.1:'+server.address().port+route);
      assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(await response.text(),expected);
    }
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('Zjh script serves a clean inning diagnostic without rewriting original static assets',async()=>{
  const file=new URL('../../static/client/2.0.1279/assets/Zjh/index.df153.js',import.meta.url);
  const original=fs.readFileSync(file,'utf8'),server=http.createServer(createClientApp());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/2.0.1279/assets/Zjh/index.df153.js');
    const source=await response.text();
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.ok(source.includes("console['log']('----------',az)"));
    assert.ok(!source.includes("console['error']('----------',az)"));
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('Bairen host initialization keeps diagnostics without reporting every ordinary entry as an error',async()=>{
  const file=new URL('../../static/client/2.0.1279/assets/Bairen/index.85029.js',import.meta.url);
  const original=fs.readFileSync(file,'utf8'),expected=adaptHundredCleanupResponse(adaptRoomUiResponse(original)),server=http.createServer(createClientApp());
  assert.notEqual(expected,original);new vm.Script(expected);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    for(const route of ['/2.0.1279/assets/Bairen/index.85029.js','/assets/Bairen/index.85029.js']){
      const response=await fetch('http://127.0.0.1:'+server.address().port+route);
      assert.equal(response.status,200);assert.equal(await response.text(),expected);
    }
    assert.equal(fs.readFileSync(file,'utf8'),original);
  }finally{await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

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

test("local overrides serve scripts, assets and cache validations with CORS", async () => {
  const server = http.createServer(createClientApp());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const url = base + "/2.0.1279/assets/main/index.88f4e.js";
    const script = await fetch(url, { headers: { Origin: "https://www.boyuee.top" } });
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type"), /javascript/);
    assert.equal(script.headers.get("access-control-allow-origin"), "*");
    await script.arrayBuffer();
    const cached = await new Promise((resolve, reject) => {
      http.get(url, { headers: { Origin: "null", "If-None-Match": script.headers.get("etag") } }, response => {
        response.resume();
        response.on("end", () => resolve(response));
      }).on("error", reject);
    });
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.headers["access-control-allow-origin"], "*");
    const options = await fetch(url, { method: "OPTIONS", headers: {
      Origin: "https://www.boyuee.top", "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-requested-with",
    } });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    assert.match(options.headers.get("access-control-allow-headers"), /x-requested-with/);
    const image = await fetch(base + "/avator/90007.png", { headers: { Origin: "https://www.boyuee.top" } });
    assert.equal(image.headers.get("access-control-allow-origin"), "*");
    await image.arrayBuffer();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

test("client app injects runtime fixes into the served game page", async () => {
  const server = http.createServer(createClientApp());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/2.0.1279/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /skip hundred cleanup without hundredDomain/);
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
  assert.match(CLIENT_DEV_PATCH, /hookSceneRequests/);
  assert.doesNotMatch(CLIENT_DEV_PATCH, /scheduleGameScene/);
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
    sendUnregRoomsReq(message) {
      cleanupCalls += 1;
      return Promise.reject(new Error(message||"当前没有hundredDomain百人服地址, 无法连接百人服"));
    }
  }
  const classes = { BairenMultyBetViewModel };
  const cc = {
    // Some packaged Cocos builds only retain this internal registry.
    js: { _nameToClass: classes },
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
  assert.equal(await BairenMultyBetViewModel.prototype.sendUnregRoomsReq("当前无可用房间服"),0);
  await assert.rejects(BairenMultyBetViewModel.prototype.sendUnregRoomsReq("unexpected failure"),/unexpected failure/);

  assert.equal(cleanupCalls, 3);
});

test("observer snapshot enables the client's gated empty-seat request", () => {
  const intervalCallbacks = [];
  const sent = [];
  const room = {
    params: {},
    getIsOb() { return false; },
    getMyObMemberInfo() { return { uid: 77, userInfo: { uid: 77 } }; },
  };
  const seatLayer = {
    _components: [{
      clickSeatDown() {
        if (room.getIsOb()) sent.push({ msgid: 5003, position: 6 });
      },
    }],
    children: [],
  };
  const cc = {
    app: { gameRoom: room },
    js: { getClassByName: () => null, _nameToClass: {} },
    assetManager: { bundles: { forEach() {} } },
    director: { getScene: () => ({ name: "gameHoldem", children: [seatLayer] }) },
  };
  const window = {
    cc,
    location: { href: "http://www.localhost:11042/2.0.1279/?userId=77&openId=77&isWebHall=1" },
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
  seatLayer._components[0].clickSeatDown();

  assert.deepEqual(sent, [{ msgid: 5003, position: 6 }]);
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
  const retries = [];
  const gameScene = { name: "gameHoldem" };
  const bundle = {
    loadScene(_name, _progress, complete) {
      loadSceneCalls += 1;
      activeScene = gameScene;
      complete(null, gameScene);
    },
  };
  const cc = {
    Notify: class Notify { emitModule() {} },
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
    __webHallEarly: { peek: () => ({ openGame: { value: { joinRoom: { roomId: 700000, roomType: 19 } } } }) },
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
    setTimeout: (callback) => { retries.push(callback); return retries.length; },
  };
  const patch = CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");

  vm.runInNewContext(patch, context);
  new cc.Notify().emitModule("common", "loading", "over", { module: "Holdem", scene: "gameHoldem" });
  retries.shift()();

  assert.equal(loadSceneCalls, 1);
  assert.equal(activeScene.name, "gameHoldem");
  assert.equal(runSceneImmediateCalls, 0);
  assert.equal(loadedMessages.filter((message) => message.type === "gameLoaded").length, 1);
  activeScene = { name: "webHallOb" };
  for (const retry of retries) retry();
  assert.equal(loadedMessages.filter((message) => message.type === "gameLoaded").length, 1,
    "delayed gameLoaded retries cannot reveal an empty scene after gameBack");
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
    Notify: class Notify { emitModule() {} },
    js: { getClassByName: () => null, _nameToClass: {} },
    assetManager: { getBundle: () => null, bundles: { forEach() {} } },
    director: { getScene: () => activeScene },
  };
  const window = {
    cc,
    __webHallEarly: { peek: () => ({ openGame: { value: { joinRoom: { roomId: 700000, roomType: 19 } } } }) },
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
  new cc.Notify().emitModule("common", "loading", "over", { module: "Holdem", scene: "gameHoldem" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(loadSceneCalls, 1);
  assert.equal(runSceneCalls, 1);
  assert.equal(activeScene.name, "gameHoldem");
  assert.ok(loadedMessages.filter((message) => message.type === "gameLoaded").length >= 1);
});
