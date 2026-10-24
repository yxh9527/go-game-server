import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { HALL_DEV_PATCH, withLoginQuery } from "./web.js";

test("withLoginQuery fills openId from userId", () => {
  const out = withLoginQuery("/21/0?userId=10001&userToken=dev", "2.0.1279");
  const q = new URL(out, "http://lobby.localhost").searchParams;
  assert.equal(q.get("openId"), "10001");
  assert.equal(q.get("userToken"), "dev");
  assert.equal(q.get("isOb"), "false");
  assert.equal(q.get("v"), "2.0.1279");
});

test("withLoginQuery keeps an existing openId", () => {
  const out = withLoginQuery("/21/0?userId=9&userToken=dev&openId=abc&v=2.0.1279", "2.0.1279");
  const q = new URL(out, "http://lobby.localhost").searchParams;
  assert.equal(q.get("openId"), "abc");
});

test("hall mountWeb does not serve Cocos client assets", () => {
  const src = fs.readFileSync(new URL("./web.js", import.meta.url), "utf8");
  assert.match(src, /renderHall/);
  assert.doesNotMatch(src, /CLIENT_DEV_PATCH/);
  assert.doesNotMatch(src, /serveClientIndex/);
});

test("hall overlay patch hides loading and shows iframe on gameLoaded", () => {
  assert.match(HALL_DEV_PATCH, /GOGAME-HALL/);
  assert.match(HALL_DEV_PATCH, /game-iframe_visible__LsoiQ/);
  assert.match(HALL_DEV_PATCH, /gameLoaded/);
  assert.match(HALL_DEV_PATCH, /\$loading/);
  assert.match(HALL_DEV_PATCH, /loading_loading/);
  assert.match(HALL_DEV_PATCH, /10001/);
  assert.match(HALL_DEV_PATCH, /stopImmediatePropagation/);
  assert.match(HALL_DEV_PATCH, /router\.push/);
  const src = fs.readFileSync(new URL("./web.js", import.meta.url), "utf8");
  assert.match(src, /HALL_DEV_PATCH/);
});

test("hall overlay observer does not watch its own style writes", () => {
  let observer;
  let observerOptions;
  let stopped = false;
  const writes = [];
  const makeStyle = (name) => {
    const values = new Map();
    const priorities = new Map();
    return {
      getPropertyValue: (key) => values.get(key) || "",
      getPropertyPriority: (key) => priorities.get(key) || "",
      setProperty(key, value, priority) {
        writes.push(`${name}:${key}`);
        values.set(key, value);
        priorities.set(key, priority);
      },
      removeProperty(key) { values.delete(key); priorities.delete(key); },
    };
  };
  const classes = new Set(["game-iframe_gameIframe__blCWg"]);
  const holder = {
    classList: {
      contains: (name) => classes.has(name),
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    },
    style: makeStyle("holder"),
  };
  const frame = { style: makeStyle("frame"), contentWindow: {} };
  const loading = { style: makeStyle("loading") };
  const document = {
    documentElement: {},
    querySelectorAll(selector) {
      if (selector.includes("iframe")) return [frame];
      if (selector.includes("gameIframe")) return [holder];
      if (selector.includes("loading_loading")) return [loading];
      return [];
    },
  };
  const window = {
    addEventListener(type, listener) {
      if (type === "message") this.onMessage = listener;
    },
    $loading() {},
  };
  class FakeMutationObserver {
    constructor(callback) {
      observer = callback;
    }
    observe(_target, options) {
      observerOptions = options;
    }
  }
  const source = HALL_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");
  vm.runInNewContext(source, {
    window,
    document,
    MutationObserver: FakeMutationObserver,
    setInterval: () => 1,
    clearInterval() {},
    console: { log() {} },
  });

  window.onMessage({ source: frame.contentWindow, data: { type: "gameLoaded" }, stopImmediatePropagation() { stopped = true; } });
  const initialWrites = writes.length;
  observer([{ type: "childList" }]);
  window.onMessage({ source: frame.contentWindow, data: { type: "gameLoaded" }, stopImmediatePropagation() { stopped = true; } });

  assert.equal(observerOptions.subtree, true);
  assert.equal(observerOptions.childList, true);
  assert.equal(observerOptions.attributes, true);
  assert.equal(observerOptions.attributeFilter.join(","), "class");
  assert.equal(writes.length, initialWrites);
  assert.equal(initialWrites, 9);
  assert.equal(classes.has("game-iframe_visible__LsoiQ"), true);
  assert.equal(stopped, true);
});

test("exit uncovers the hall through rerenders and a second entry/exit without navigating back", () => {
  let observe, tick;
  const visible = "game-iframe_visible__LsoiQ";
  const makeNode = () => {
    const values = new Map(), priorities = new Map(), classes = new Set();
    return {
      style: {
        getPropertyValue: (name) => values.get(name) || "",
        getPropertyPriority: (name) => priorities.get(name) || "",
        setProperty(name, value, priority) { values.set(name, value); priorities.set(name, priority); },
        removeProperty(name) { values.delete(name); priorities.delete(name); },
      },
      classList: { contains: (name) => classes.has(name), add: (name) => classes.add(name), remove: (name) => classes.delete(name) },
    };
  };
  let holder = makeNode();
  const frame = { ...makeNode(), contentWindow: {} };
  const loading = makeNode();
  const loadingCalls = [];
  let backCalls = 0;
  const window = { $loading: (value) => loadingCalls.push(value),
    addEventListener(type, listener) { if (type === "message") this.onMessage = listener; },
  };
  const source = HALL_DEV_PATCH.replace(/^<script>\s*/, "").replace(/\s*<\/script>$/, "");
  vm.runInNewContext(source, { window, console: { log() {} }, clearInterval() {},
    setInterval(callback) { tick = callback; return 1; },
    MutationObserver: class { constructor(callback) { observe = callback; } observe() {} },
    document: { documentElement: {}, querySelectorAll(selector) {
      if (selector.includes("iframe")) return [frame];
      if (selector.includes("gameIframe")) return [holder];
      if (selector.includes("loading_loading")) return [loading];
      return [];
    } },
  });
  const dispatch = (type, source = frame.contentWindow) => {
    let stopped = false;
    window.onMessage({ source, data: JSON.stringify({ type }), stopImmediatePropagation() { stopped = true; } });
    // Original React gameBack calls router.back(). It must be paired with
    // the route push that our existing gameLoaded bridge intentionally skips.
    if (!stopped && type === "gameBack" && source === frame.contentWindow) backCalls += 1;
    return stopped;
  };
  tick();
  assert.equal(dispatch("gameLoaded", {}), false, "ignore messages from unrelated frames");
  assert.equal(holder.classList.contains(visible), false);
  for (let cycle = 0; cycle < 2; cycle++) {
    window.$loading(true);
    assert.equal(loadingCalls.at(-1), true);
    assert.equal(loading.style.getPropertyValue("display"), "", "entry can show loading again");
    assert.equal(dispatch("gameLoaded"), true);
    assert.equal(holder.style.getPropertyValue("visibility"), "visible");
    assert.equal(frame.style.getPropertyValue("pointer-events"), "auto");
    assert.equal(dispatch("gameBack", {}), false);
    assert.equal(holder.style.getPropertyValue("visibility"), "visible");
    assert.equal(dispatch("gameBack"), true);
    assert.equal(dispatch("gameBack"), true, "duplicate exits must not navigate outside the hall");
    assert.equal(holder.classList.contains(visible), false);
    assert.equal(holder.style.getPropertyValue("visibility"), "hidden");
    assert.equal(holder.style.getPropertyValue("z-index"), "-1");
    assert.equal(frame.style.getPropertyValue("pointer-events"), "none");
    holder = makeNode();
    holder.classList.add(visible);
    observe([{ type: "childList" }]);
    tick();
    assert.equal(holder.classList.contains(visible), false, "React replacement cannot resurrect the black overlay");
    assert.equal(holder.style.getPropertyValue("visibility"), "hidden");
    assert.equal(backCalls, 0);
  }
  dispatch("gameLoaded");
  assert.equal(dispatch("errText"), false, "preserve native error handling");
  assert.equal(holder.style.getPropertyValue("visibility"), "hidden");
});
