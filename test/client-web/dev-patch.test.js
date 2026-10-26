import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import { CLIENT_DEV_PATCH } from "../../cache/client-web/dev-patch.js";

// Run the injected adapter with a real message/cache lifecycle and a virtual
// clock, so a long idle hall and callbacks from earlier entries are exercised.
function browser({ early = false, handler = true, nativeStart = false } = {}) {
  let now = 0;
  let nextTimer = 0;
  let activeScene = { name: "webHallOb" };
  let onOpen = () => {};
  let onLoad = (_name, _progress, done) => done(null, { name: "gameHoldem" });
  const timers = new Map();
  const listeners = [];
  const logs = [];
  const opens = [];
  const loaded = [];
  const runs = [];
  const loads = [];
  const classes = {};
  class Notify { emitModule() { return 'original-notification'; } }
  function WebHallOb() {}
  WebHallOb.handleOpenGame = (value) => { opens.push(value); onOpen(value); };
  WebHallOb.prototype.start = function () {
    if (!nativeStart) return;
    const cache = window.__webHallEarly.take();
    if (cache?.openGame) WebHallOb.handleOpenGame(cache.openGame.value);
  };
  if (handler) classes.WebHallOb = WebHallOb;
  if (nativeStart) activeScene._components = [new WebHallOb()];
  const bundle = {
    loadScene(name, progress, done) {
      loads.push(name);
      onLoad(name, progress, done);
    },
  };
  const cc = {
    Notify,
    js: { getClassByName: (name) => classes[name] || null, _nameToClass: classes },
    director: {
      getScene: () => activeScene,
      runSceneImmediate(scene, _before, after) {
        runs.push(scene.name);
        activeScene = scene;
        after?.();
      },
    },
    assetManager: { getBundle: () => bundle, bundles: { forEach() {} } },
  };
  const location = {
    href: "http://www.localhost:11042/2.0.1279/?userId=10001&openId=10001&isWebHall=1",
    search: "?userId=10001&openId=10001&isWebHall=1",
  };
  const window = {
    cc, location,
    WebSocket: class WebSocket {},
    parent: { postMessage: (message) => loaded.push(message) },
    addEventListener(type, fn, capture = false) { listeners.push({ type, fn, capture }); },
    removeEventListener(type, fn) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  function timer(fn, delay, interval = 0) {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay, interval });
    return id;
  }
  const context = {
    window, cc, location, URL, URLSearchParams,
    Date: class extends Date { static now() { return now; } },
    document: { getElementById: () => null },
    history: { replaceState() {} },
    XMLHttpRequest: class XMLHttpRequest { open() {} },
    console: { log: (...args) => logs.push(args.join(" ")), warn() {}, error() {} },
    setInterval: (fn, delay) => timer(fn, delay, delay),
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, delay = 0) => timer(fn, delay),
    clearTimeout: (id) => timers.delete(id),
  };
  vm.createContext(context);
  if (early) vm.runInContext(fs.readFileSync(new URL("../../static/client/2.0.1279/js/webHallEarly.js", import.meta.url), "utf8"), context);
  vm.runInContext(CLIENT_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, ""), context);
  return {
    logs, opens, loaded, runs, loads, window,
    requestScene(options) { return new Notify().emitModule('common', 'loading', 'over', options); },
    setScene(name) {
      activeScene = { name };
      if (name === "webHallOb" && nativeStart) activeScene._components = [new WebHallOb()];
    },
    setHandler(fn) { onOpen = fn; classes.WebHallOb = WebHallOb; },
    setLoader(fn) { onLoad = fn; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const entry = [...timers].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, task] = entry;
        now = task.at;
        if (task.interval) task.at += task.interval;
        else timers.delete(id);
        task.fn();
      }
      now = until;
    },
    open(roomId, roomType = 25) {
      const data = { type: "openGame", value: { joinRoom: { roomId, roomType, isOb: false } } };
      for (const listener of [...listeners].sort((a, b) => Number(b.capture) - Number(a.capture))) {
        if (listener.type === "message") listener.fn({ data, source: window.parent });
      }
    },
  };
}

test('shared loading notification opens the requested Zjh bundle and retires callbacks on exit', () => {
  const page = browser();
  page.setLoader((name, _progress, done) => done(null, { name }));
  page.open(25010000, 25);
  assert.equal(page.requestScene({ module: 'Zjh', scene: 'gameZjh' }), 'original-notification');
  page.advance(200);
  assert.deepEqual(page.loads, ['gameZjh']);
  assert.deepEqual(page.runs, ['gameZjh']);
  assert.ok(page.loaded.length > 0);
  page.requestScene({ module: 'Zjh', scene: 'gameZjh' });
  page.advance(200);
  assert.equal(page.runs.length, 1, 'does not reset a live game scene');
  page.setScene('webHallOb');
  page.advance(200);
  const count = page.loaded.length;
  page.requestScene({ module: 'Zjh', scene: 'gameZjh' });
  page.advance(3000);
  assert.equal(page.runs.length, 1);
  assert.equal(page.loaded.length, count);
});

test("idle hall never starts an empty delivery or timeout", () => {
  const page = browser();
  page.advance(60000);
  assert.equal(page.opens.length, 0);
  assert.equal(page.loads.length, 0);
  assert.deepEqual(page.logs.filter((line) => /deliver (empty|timeout|wait)/.test(line)), []);
});

test("delivery deadline begins with a request, reports once, and resets for the next request", () => {
  const page = browser({ handler: false });
  page.advance(60000);
  page.open(700000);
  page.advance(7999);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 0);
  page.advance(60001);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 1);
  assert.equal(page.logs.filter((line) => /deliver wait WebHallOb/.test(line)).length, 1);
  page.setHandler(() => {});
  page.advance(1000);
  assert.equal(page.opens.length, 0, "expired requests stop retrying");
  page.open(700001);
  page.advance(60000);
  assert.deepEqual(page.opens.map((value) => value.joinRoom.roomId), [700001]);
  assert.equal(page.opens[0].joinRoom.isOb, true);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 1);
});

test("a handler that becomes available before the deadline receives the pending request once", () => {
  const page = browser({ handler: false });
  page.open(700000);
  page.advance(6000);
  page.setHandler(() => {});
  page.advance(60000);
  assert.equal(page.opens.length, 1);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 0);
});

test("handler failures have bounded retries and do not repeat identical errors", () => {
  const page = browser();
  page.setHandler(() => { throw new Error("handler unavailable"); });
  page.open(700000);
  page.advance(8000);
  const attempts = page.opens.length;
  assert.ok(attempts > 1);
  page.advance(60000);
  assert.equal(page.opens.length, attempts);
  assert.equal(page.logs.filter((line) => /handleOpenGame err/.test(line)).length, 1);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 1);
});

test("original Cocos startup can consume the early cache without duplicate delivery", () => {
  const page = browser({ early: true, nativeStart: true });
  // The request arrives before the waiting scene; the original start takes it.
  page.setScene("launch");
  page.open(700000);
  page.advance(40);
  page.setScene("webHallOb");
  page.advance(60000);
  assert.equal(page.opens.length, 1, "only original startup handles the cached request");
  assert.equal(page.opens[0].joinRoom.isOb, true);
  assert.equal(page.window.__webHallEarly.peek().openGame, null);
  assert.equal(page.logs.filter((line) => /deliver timeout/.test(line)).length, 0);
});

test("returning to the hall retires pending work and permits another entry", () => {
  const page = browser();
  page.setHandler(() => page.setScene("gameHoldem"));
  page.open(700000, 19);
  page.advance(200);
  const initialLoaded = page.loaded.length;
  assert.ok(initialLoaded > 0);
  page.setScene("webHallOb");
  page.advance(60000);
  assert.equal(page.loaded.length, initialLoaded, "old gameLoaded retries stay retired");
  assert.equal(page.opens.length, 1);
  assert.equal(page.loads.length, 0, "returning must not load the old game");
  assert.equal(page.logs.filter((line) => /deliver (empty|timeout)/.test(line)).length, 0);
  page.open(700001, 19);
  page.advance(2000);
  assert.deepEqual(page.opens.map((value) => value.joinRoom.roomId), [700000, 700001]);
  assert.ok(page.loaded.length > initialLoaded, "new entry has its own gameLoaded notifications");
});

test("old asynchronous scene loads cannot run after exit or a subsequent entry", () => {
  const page = browser();
  let complete;
  page.setLoader((_name, _progress, done) => { complete = done; });
  page.open(700000, 19);
  page.advance(200);
  assert.equal(page.loads.length, 1);
  page.setScene("gameHoldem"); // The original client finishes entering first.
  page.advance(200);
  page.setScene("webHallOb");
  page.advance(200);
  const loadedBefore = page.loaded.length;
  complete(null, { name: "gameHoldem" });
  assert.equal(page.runs.length, 0);
  assert.equal(page.loaded.length, loadedBefore);
  page.open(700001);
  complete(null, { name: "gameHoldem" });
  assert.equal(page.runs.length, 0, "old completion cannot be adopted by a newer request");
  assert.deepEqual(page.opens.map((value) => value.joinRoom.roomId), [700000, 700001]);
});

test("a stale SceneManager promise cannot run an old scene after returning", async () => {
  const page = browser();
  let resolveLoad;
  let runs = 0;
  const manager = {
    loadScene: () => new Promise((resolve) => { resolveLoad = resolve; }),
    runScene: () => { runs += 1; },
  };
  page.window.__require = () => ({ default: { instance: manager } });
  page.open(700000, 19);
  page.advance(200);
  assert.equal(typeof resolveLoad, "function");
  page.setScene("gameHoldem");
  page.advance(200);
  page.setScene("webHallOb");
  page.advance(200);
  resolveLoad({ scene: "gameHoldem" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 0);
  page.advance(60000);
  assert.equal(page.logs.filter((line) => /deliver (empty|timeout)/.test(line)).length, 0);
});
