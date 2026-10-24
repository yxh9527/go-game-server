export const CLIENT_DEV_PATCH = `<script>
(function () {
  var rawLog = console.log.bind(console);
  var rawWarn = console.warn.bind(console);
  var rawError = console.error.bind(console);
  function keepConsole() {
    console.log = rawLog;
    console.warn = function () {
      rawWarn.apply(console, arguments);
      try {
        if (arguments[0] === "进入游戏" && arguments[1]) {
          loadGameScene({ module: "Holdem", scene: String(arguments[1]) });
        }
      } catch (e) {}
    };
    console.error = rawError;
    if (window.cc) {
      cc.log = rawLog;
      cc.warn = console.warn;
      cc.error = rawError;
      if (cc.app && !cc.app.webImgPool) cc.app.webImgPool = Object.create(null);
      hookPersist();
    }
  }
  keepConsole();
  setInterval(keepConsole, 250);

  function step(msg) {
    keepConsole();
    rawLog("[GOGAME-DEV]", msg);
  }
  step("patch start " + location.href);

  function sitOpenGame(data) {
    try {
      if (data && data.type === "openGame" && data.value && data.value.joinRoom) {
        data.value.joinRoom.isOb = true;
      }
    } catch (e) {}
    return data;
  }

  function lang() {
    try {
      return (new URLSearchParams(location.search).get("language") || "zh_cn").replace(/-/g, "_");
    } catch (e) {
      return "zh_cn";
    }
  }
  var LANG_MODULES = ["common", "login", "server", "web", "payment"];
  function mappedBundle(name) {
    if (LANG_MODULES.indexOf(name) < 0) return name;
    return "holdemGame_" + lang() + "_" + name;
  }
  function aliasLangBundles(settings) {
    if (!settings || !settings.bundleVers) return;
    for (var i = 0; i < LANG_MODULES.length; i++) {
      var name = LANG_MODULES[i];
      var key = "holdemGame_" + lang() + "_" + name;
      if (!settings.bundleVers[name] && settings.bundleVers[key]) {
        settings.bundleVers[name] = settings.bundleVers[key];
      }
    }
  }

  try {
    var loc = new URL(window.location.href);
    var changed = false;
    if (!loc.searchParams.get("openId")) {
      loc.searchParams.set("openId", loc.searchParams.get("userId") || "10001");
      changed = true;
    }
    if (loc.searchParams.get("isWebHall") !== "1") {
      loc.searchParams.set("isWebHall", "1");
      changed = true;
    }
    if (changed) {
      history.replaceState(null, "", loc.pathname + loc.search + loc.hash);
      step("url patched " + loc.search);
    }
  } catch (e) {}

  window.installBundle = function (name) {
    var fire = function () {
      if (typeof window.onBundleInstallProgress === "function") window.onBundleInstallProgress(name, 1);
    };
    fire();
    setTimeout(fire, 0);
  };

  function rewriteAssetUrl(url) {
    if (typeof url !== "string") return url;
    url = url.replace(/^https?:\\/\\/api\\.pansu\\.xyz(\\/internal\\/v1\\/do(?:\\?.*)?)$/i, function (_all, path) {
      return "http://lobby.localhost" + (location.port ? ":" + location.port : "") + "/api" + path;
    });
    return url.replace(/\\/assets\\/(common|login|server|web|payment)\\/(config|index)(\\.[^/?]*)?(\\?.*)?$/, function (_all, mod, file, ext, query) {
      var mapped = mappedBundle(mod);
      var hash = window._CCSettings && _CCSettings.bundleVers && _CCSettings.bundleVers[mapped];
      var fallback = { common: "cc744", login: "95d0c", server: "823c3", web: "a3b19", payment: "cb28d" };
      hash = hash || fallback[mod];
      var suffix = file === "config" ? ".json" : ".js";
      if (ext && /\\.(json|js)$/.test(ext) && hash && ext.indexOf(hash) >= 0) return _all;
      return "/assets/" + mapped + "/" + file + "." + hash + suffix + (query || "");
    });
  }
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = rewriteAssetUrl(url);
    return origOpen.apply(this, arguments);
  };
  try {
    var scriptDesc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
    if (scriptDesc && scriptDesc.set) {
      Object.defineProperty(HTMLScriptElement.prototype, "src", {
        configurable: true,
        enumerable: scriptDesc.enumerable,
        get: scriptDesc.get,
        set: function (value) { scriptDesc.set.call(this, rewriteAssetUrl(value)); },
      });
    }
  } catch (e) {}
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      if (typeof input === "string") input = rewriteAssetUrl(input);
      else if (input && input.url) {
        var next = rewriteAssetUrl(input.url);
        if (next !== input.url) input = new Request(next, input);
      }
      return origFetch(input, init);
    };
  }

  var Orig = window.WebSocket;
  function Wrapped(url, protocols) {
    if (typeof url === "string" && url.indexOf("wss://") === 0) {
      url = "ws://" + url.slice(6);
    }
    step("WebSocket " + url);
    var ws = arguments.length > 1 ? new Orig(url, protocols) : new Orig(url);
    ws.addEventListener("open", function () { step("WebSocket open " + url); });
    ws.addEventListener("error", function () { step("WebSocket error " + url); });
    ws.addEventListener("close", function (ev) { step("WebSocket close " + url + " code=" + (ev && ev.code)); });
    return ws;
  }
  Wrapped.prototype = Orig.prototype;
  Wrapped.CONNECTING = Orig.CONNECTING;
  Wrapped.OPEN = Orig.OPEN;
  Wrapped.CLOSING = Orig.CLOSING;
  Wrapped.CLOSED = Orig.CLOSED;
  window.WebSocket = Wrapped;

  var savedOpenGame = null;
  var cocosTook = false;
  var delivered = false;
  var deliveryStartedAt = null;
  var deliveryTimedOut = false;
  var deliveryNotice = "";
  var entryVersion = 0;
  var entryRetired = false;
  var gameActive = false;
  function resetEntry() {
    entryVersion += 1;
    savedOpenGame = null;
    cocosTook = false;
    delivered = false;
    deliveryStartedAt = null;
    deliveryTimedOut = false;
    deliveryNotice = "";
    sceneReady = false;
    loadingGame = false;
    pendingGame = null;
    postedLoaded = false;
    loadedSends = 0;
    gameActive = false;
  }
  function beginEntry(data) {
    resetEntry();
    entryRetired = false;
    savedOpenGame = sitOpenGame(data);
  }
  function retireReturnedEntry() {
    var scene = window.cc && cc.director && cc.director.getScene();
    if (gameActive && scene && HALL_WAIT[scene.name]) {
      resetEntry();
      entryRetired = true;
      step("entry retired on return to hall");
    }
  }
  function currentEntry(version) {
    retireReturnedEntry();
    return version === entryVersion && !entryRetired;
  }
  function deliveryStep(message) {
    if (deliveryNotice === message) return;
    deliveryNotice = message;
    step(message);
  }
  window.addEventListener("message", function (ev) {
    var data = ev && ev.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return; }
    }
    if (data && data.type === "openGame") {
      beginEntry(data);
      step("capture openGame");
      var scene = window.cc && cc.director && typeof cc.director.getScene === "function" && cc.director.getScene();
      if (scene && scene.name === "webHallOb") deliverOpenGame("capture");
    }
  }, true);

  var earlyTries = 0;
  var earlyTimer = setInterval(function () {
    var early = window.__webHallEarly;
    if (early && !early.__sitPatched) {
      var take = early.take.bind(early);
      early.take = function () {
        var cached = take();
        step("webHallEarly.take " + (cached && cached.openGame ? "openGame" : "empty"));
        if (cached && cached.openGame) {
          if (entryRetired) cached.openGame = null;
          else {
            if (savedOpenGame !== cached.openGame) beginEntry(cached.openGame);
            sitOpenGame(cached.openGame);
            cocosTook = true;
          }
        }
        return cached;
      };
      early.__sitPatched = true;
    }
    if (early && early.__sitPatched || ++earlyTries > 300) clearInterval(earlyTimer);
  }, 20);

  var settingsTries = 0;
  var settingsTimer = setInterval(function () {
    var settings = window._CCSettings;
    if (settings && settings.bundleVers) aliasLangBundles(settings);
    if (settings && settings.bundleVers || ++settingsTries > 300) clearInterval(settingsTimer);
  }, 20);

  var bundleTries = 0;
  var bundleTimer = setInterval(function () {
    if (!window.cc || !cc.assetManager || typeof cc.assetManager.loadBundle !== "function") {
      if (++bundleTries > 400) clearInterval(bundleTimer);
      return;
    }
    clearInterval(bundleTimer);
    var orig = cc.assetManager.loadBundle.bind(cc.assetManager);
    cc.assetManager.loadBundle = function (name, opts, cb) {
      var mapped = mappedBundle(name);
      if (mapped !== name) step("loadBundle remap " + name + " -> " + mapped);
      return orig(mapped, opts, cb);
    };
    orig(mappedBundle("common"), function (err) {
      step("preload common " + (err ? String(err) : "ok"));
    });
  }, 20);

  function peekOpenGame() {
    if (entryRetired) return null;
    if (savedOpenGame) return savedOpenGame;
    var early = window.__webHallEarly;
    if (early && typeof early.peek === "function") {
      var cached = early.peek();
      if (cached && cached.openGame) return cached.openGame;
    }
    return null;
  }

  function getClass(name) {
    try {
      if (cc.js && typeof cc.js.getClassByName === "function") {
        var registered = cc.js.getClassByName(name);
        if (registered) return registered;
      }
    } catch (e) {}
    // Cocos builds do not always expose every decorated class through
    // getClassByName. The minified game bundles still register them here.
    try {
      var classes = cc.js && (cc.js._nameToClass || cc.js._registeredClassNames);
      if (classes && classes[name]) return classes[name];
    } catch (e2) {}
    return null;
  }

  function instOf(Cls) {
    if (!Cls) return null;
    var inst = Cls.instance || Cls._instance || (Cls.default && (Cls.default.instance || Cls.default._instance));
    if (inst && typeof inst.loadScene === "function" && typeof inst.runScene === "function") return inst;
    if (typeof Cls.loadScene === "function" && typeof Cls.runScene === "function") return Cls;
    return null;
  }

  function findRuntimeSceneManager() {
    try {
      var req = window && window.__require;
      if (typeof req !== "function") return null;
      var ids = ["SceneManager", "framework/singles/SceneManager"];
      for (var i = 0; i < ids.length; i++) {
        var mod = null;
        try { mod = req(ids[i]); } catch (e) { mod = null; }
        if (!mod) continue;
        var candidates = [mod, mod.default, mod.SceneManager, mod.default && mod.default.default];
        for (var j = 0; j < candidates.length; j++) {
          var inst = instOf(candidates[j]);
          if (inst) return inst;
        }
      }
    } catch (e) {}
    return null;
  }

  function findSceneManager() {
    var inst = instOf(getClass("SceneManager"));
    if (inst) return inst;
    inst = findRuntimeSceneManager();
    if (inst) {
      step("SceneManager via runtime module");
      return inst;
    }
    try {
      var map = cc.js && (cc.js._nameToClass || cc.js._idToClass);
      if (map) {
        for (var k in map) {
          inst = instOf(map[k]);
          if (inst) return inst;
        }
      }
    } catch (e) {}
    return null;
  }

  function walkNodes(node, visit) {
    if (!node) return;
    visit(node);
    var children = node.children || node._children || [];
    for (var i = 0; i < children.length; i++) walkNodes(children[i], visit);
  }

  function findHandleOpenGame() {
    var Cls = webHallObClass();
    if (Cls && typeof Cls.handleOpenGame === "function") return Cls.handleOpenGame.bind(Cls);
    try {
      var scene = cc.director && cc.director.getScene();
      var found = null;
      walkNodes(scene, function (node) {
        if (found) return;
        var comps = node._components || [];
        for (var i = 0; i < comps.length; i++) {
          var c = comps[i];
          if (c && typeof c.handleOpenGame === "function") {
            found = c.handleOpenGame.bind(c);
            return;
          }
          var ctor = c && c.constructor;
          if (ctor && typeof ctor.handleOpenGame === "function") {
            found = ctor.handleOpenGame.bind(ctor);
            return;
          }
        }
      });
      if (found) return found;
    } catch (e) {}
    return null;
  }

  function webHallObClass() {
    var Cls = getClass("WebHallOb");
    if (Cls && typeof Cls.handleOpenGame === "function") return Cls;
    try {
      var found = null;
      walkNodes(cc.director && cc.director.getScene(), function (node) {
        if (found) return;
        var comps = node._components || [];
        for (var i = 0; i < comps.length; i++) {
          var ctor = comps[i] && comps[i].constructor;
          if (ctor && typeof ctor.handleOpenGame === "function") {
            found = ctor;
            return;
          }
        }
      });
      return found;
    } catch (e) {
      return null;
    }
  }

  function hookWebHallOb() {
    var Cls = webHallObClass();
    if (!Cls || Cls.__gogameHooked || !Cls.prototype) return;
    Cls.__gogameHooked = true;
    var origStart = Cls.prototype.start;
    Cls.prototype.start = function () {
      step("WebHallOb.start");
      if (origStart) origStart.apply(this, arguments);
      setTimeout(function () { deliverOpenGame("afterStart"); }, 50);
    };
  }

  var launchOverlayHidden = false;
  function hideLaunchOverlay() {
    try {
      var changed = [];
      function cover(el, tag) {
        if (!el) return;
        if (el.id === "GameCanvas" || el.id === "Cocos2dGameContainer") return;
        if (el.style.display === "none" && el.style.pointerEvents === "none") return;
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("visibility", "hidden", "important");
        el.style.setProperty("pointer-events", "none", "important");
        el.style.setProperty("z-index", "-1", "important");
        changed.push(tag);
      }
      cover(document.getElementById("splash"), "#splash");
      cover(document.getElementById("loading-container"), "#loading-container");
      cover(document.getElementById("launch-new-api"), "#launch-new-api");
      var app = document.getElementById("app");
      if (app && !app.querySelector("#GameCanvas, #Cocos2dGameContainer, canvas")) cover(app, "#app");
      var canvas = document.getElementById("GameCanvas");
      if (canvas) canvas.style.pointerEvents = "auto";
      if (changed.length && !launchOverlayHidden) {
        launchOverlayHidden = true;
        step("hide launch overlay " + changed.join(","));
      }
    } catch (e) {}
  }
  function watchLaunchOverlay() {
    if (document.__gogameLaunchObs) return;
    document.__gogameLaunchObs = true;
    try {
      var obs = new MutationObserver(function () {
        if (sceneReady || isHoldemScene()) hideLaunchOverlay();
      });
      obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    } catch (e) {}
  }

  function clearLoadingScene() {
    try {
      var SM = findSceneManager();
      if (SM) SM.isLoadingScene = false;
    } catch (e) {}
    if (isHoldemScene()) hideLaunchOverlay();
  }

  function invokeStarts(scene) {
    walkNodes(scene, function (node) {
      var comps = node._components || [];
      for (var i = 0; i < comps.length; i++) {
        var c = comps[i];
        var ctor = c && c.constructor;
        if (!c || typeof c.start !== "function" || !ctor || typeof ctor.handleOpenGame !== "function") continue;
        if (c.__gogameStarted) continue;
        c.__gogameStarted = true;
        try {
          c.start();
        } catch (e) {
          step("start err " + e);
        }
      }
    });
  }

  function deliverOpenGame(reason) {
    retireReturnedEntry();
    var scene = window.cc && cc.director && cc.director.getScene();
    if (entryRetired || !scene || scene.name !== "webHallOb") return false;
    if (delivered) return true;
    if (cocosTook) {
      step("deliver skip, cocos took " + reason);
      delivered = true;
      return true;
    }
    var msg = peekOpenGame();
    // An idle webHallOb is normal, both before entry and after gameBack.
    // Only an actual openGame request owns a delivery deadline.
    if (!msg) return false;
    if (savedOpenGame !== msg) beginEntry(msg);
    if (deliveryTimedOut) return false;
    if (deliveryStartedAt === null) deliveryStartedAt = Date.now();
    if (Date.now() - deliveryStartedAt >= 8000) {
      deliveryTimedOut = true;
      step("deliver timeout");
      return false;
    }
    sitOpenGame(msg);
    hookWebHallOb();
    var fn = findHandleOpenGame();
    if (!fn) {
      deliveryStep("deliver wait WebHallOb");
      return false;
    }
    delivered = true;
    var value = msg.value || msg;
    step("deliver handleOpenGame " + reason + " roomId=" + (value && value.joinRoom && value.joinRoom.roomId));
    try {
      fn(value);
      scheduleHoldemScene(value);
    } catch (e) {
      delivered = false;
      deliveryStep("handleOpenGame err " + e);
      return false;
    }
    return true;
  }
  function scheduleHoldemScene(value) {
    var join = value && value.joinRoom;
    var conn = value && value.connectRoomData;
    var rt = Number((join && join.roomType) || (conn && conn.roomType) || 0);
    if (rt !== 19 && rt !== 101) return;
    var version = entryVersion;
    setTimeout(function () {
      if (!currentEntry(version)) return;
      loadGameScene({ module: "Holdem", scene: "gameHoldem" });
    }, 200);
  }

  var postedLoaded = false;
  var sceneReady = false;
  var loadingGame = false;
  var pendingGame = null;
  var HALL_WAIT = { launch: 1, webHallOb: 1, login: 1, HallScene: 1, api_hall: 1 };
  function markActiveHoldemScene(opts, reason) {
    if (!opts || opts.scene !== "gameHoldem" || !isHoldemScene()) return false;
    loadingGame = false;
    sceneReady = true;
    clearLoadingScene();
    hideBairenOverlay();
    postGameLoaded(opts.scene);
    step(reason + " " + opts.scene);
    return true;
  }
  function loadGameScene(opts) {
    var version = entryVersion;
    if (!currentEntry(version)) return;
    if (!opts || !opts.scene || HALL_WAIT[opts.scene] || sceneReady) return;
    if (markActiveHoldemScene(opts, "scene already active")) return;
    pendingGame = opts;
    if (loadingGame) return;
    var inst = findSceneManager();
    if (inst) {
      var active = cc.director && cc.director.getScene();
      if (active && active.name === opts.scene && inst.currentOptions && inst.currentOptions.scene === opts.scene) {
        sceneReady = true;
        postGameLoaded(opts.scene);
        return;
      }
      loadingGame = true;
      step("loadScene " + opts.module + " " + opts.scene);
      Promise.resolve(inst.loadScene(opts)).then(function (pack) {
        if (!currentEntry(version)) return null;
        if (markActiveHoldemScene(opts, "skip duplicate scene")) return null;
        return inst.runScene(pack);
      }).then(function () {
        if (!currentEntry(version)) return;
        if (sceneReady) return;
        step("runScene done " + opts.scene);
        sceneReady = true;
        postGameLoaded(opts.scene);
      }).catch(function (err) {
        if (!currentEntry(version)) return;
        loadingGame = false;
        step("loadScene err " + err);
        loadSceneDirect(opts);
      });
      return;
    }
    step("SceneManager missing, direct");
    loadSceneDirect(opts);
  }
  function bundleNames() {
    var names = [];
    try {
      var bundles = cc.assetManager && cc.assetManager.bundles;
      if (bundles && typeof bundles.forEach === "function") {
        bundles.forEach(function (b) { if (b && b.name) names.push(b.name); });
      }
    } catch (e) {}
    return names;
  }
  function loadSceneDirect(opts) {
    var version = entryVersion;
    if (!currentEntry(version)) return;
    var am = cc.assetManager;
    if (!am) {
      loadingGame = false;
      step("assetManager missing");
      return;
    }
    loadingGame = true;
    function run(bundle) {
      if (!currentEntry(version)) return;
      if (!bundle || typeof bundle.loadScene !== "function") {
        loadingGame = false;
        step("bundle missing " + opts.module + " have " + bundleNames().join(","));
        return;
      }
      step("loadSceneDirect " + opts.module + " " + opts.scene);
      bundle.loadScene(opts.scene, function () {}, function (err, sc) {
        if (!currentEntry(version)) return;
        if (err || !sc) {
          loadingGame = false;
          step("loadSceneDirect err " + err);
          return;
        }
        if (markActiveHoldemScene(opts, "skip duplicate scene")) return;
        try {
          cc.director.runSceneImmediate(sc, null, function () {
            if (!currentEntry(version)) return;
            step("runSceneImmediate " + opts.scene);
            sceneReady = true;
            clearLoadingScene();
            hideBairenOverlay();
            postGameLoaded(opts.scene);
            setTimeout(hideBairenOverlay, 0);
            setTimeout(hideBairenOverlay, 400);
            setTimeout(hideBairenOverlay, 1200);
            setTimeout(hideBairenOverlay, 2500);
          });
        } catch (e) {
          loadingGame = false;
          step("runSceneImmediate err " + e);
        }
      });
    }
    var bundle = typeof am.getBundle === "function" ? am.getBundle(opts.module) : null;
    if (bundle) {
      run(bundle);
      return;
    }
    am.loadBundle(opts.module, null, function (err, b) {
      if (!currentEntry(version)) return;
      if (err || !b) {
        loadingGame = false;
        step("loadBundle err " + (err || opts.module) + " have " + bundleNames().join(","));
        return;
      }
      run(b);
    });
  }
  function isHoldemScene() {
    try {
      var scene = cc.director && cc.director.getScene();
      return !!(scene && scene.name === "gameHoldem");
    } catch (e) {
      return false;
    }
  }
  function isLoadingPersist(node) {
    return /^(connectTips|ProgressLoading|ApiLoading)$/i.test(String((node && node.name) || ""));
  }
  function isHiddenPersist(node) {
    return isLoadingPersist(node);
  }
  function muteNode(node) {
    if (!node) return false;
    try {
      if (node.active === false) return false;
      node.active = false;
      return node.active === false;
    } catch (e) {
      return false;
    }
  }
  function hookPersist() {
    try {
      if (!window.cc || !cc.game || typeof cc.game.addPersistRootNode !== "function" || cc.game.__bairenHide) return;
      cc.game.__bairenHide = true;
      var origPersist = cc.game.addPersistRootNode.bind(cc.game);
      cc.game.addPersistRootNode = function (node) {
        origPersist(node);
        try {
          if (isHoldemScene() && isHiddenPersist(node) && muteNode(node)) step("persist hide " + (node && node.name));
        } catch (e) {}
      };
      step("persist hook");
    } catch (e) {}
  }
  function hideBairenOverlay() {
    try {
      hookPersist();
      hookGameUtils();
      watchLaunchOverlay();
      hideLaunchOverlay();
      if (!isHoldemScene()) return;
      var map = cc.game && cc.game._persistRootNodes;
      if (!map) return;
      var hidden = [];
      Object.keys(map).forEach(function (id) {
        var node = map[id];
        if (!node) return;
        if (isHiddenPersist(node) && muteNode(node)) hidden.push(node.name || id);
      });
      if (hidden.length) step("hide persist " + hidden.join(","));
      hideConnectTips();
    } catch (e) {}
  }
  function hideConnectTips() {
    try {
      walkNodes(cc.director && cc.director.getScene(), function (node) {
        var nm = String((node && node.name) || "");
        if (/^(connectTips|ProgressLoading|ApiLoading)$/i.test(nm)) muteNode(node);
        var comps = node && node._components || [];
        for (var i = 0; i < comps.length; i++) {
          var ctor = comps[i] && comps[i].constructor;
          var cn = (ctor && (ctor.name || ctor.prototype && ctor.prototype.__classname__)) || "";
          if (/^(ConnectTips|ProgressLoading|ApiLoading)$/i.test(String(cn))) muteNode(node);
        }
      });
    } catch (e) {}
    try {
      var GU = findGameUtils();
      if (GU && typeof GU.closeAllLoading === "function") GU.closeAllLoading();
      else if (GU && typeof GU.hideLoading === "function") GU.hideLoading(true);
    } catch (e) {}
  }
  function findGameUtils() {
    try {
      var named = cc.js && cc.js.getClassByName && cc.js.getClassByName("GameUtils");
      if (named && typeof named.showLoading === "function") return named;
    } catch (e) {}
    try {
      var map = cc.js && (cc.js._registeredClassNames || cc.js._nameToClass);
      if (map && map.GameUtils && typeof map.GameUtils.showLoading === "function") return map.GameUtils;
    } catch (e2) {}
    return null;
  }
  function hookGameUtils() {
    try {
      var GU = findGameUtils();
      if (!GU || GU.__gogameLoadHook || typeof GU.showLoading !== "function") return;
      GU.__gogameLoadHook = true;
      var origShow = GU.showLoading.bind(GU);
      var origHide = typeof GU.hideLoading === "function" ? GU.hideLoading.bind(GU) : null;
      GU.showLoading = function () {
        if (sceneReady || isHoldemScene()) {
          if (origHide) origHide(true);
          hideConnectTips();
          return;
        }
        return origShow.apply(this, arguments);
      };
      step("GameUtils showLoading hook");
    } catch (e) {}
  }
  function hookObserverSeatDown() {
    try {
      if (!isHoldemScene() || !cc.app || !cc.app.gameRoom) return;
      var room = cc.app.gameRoom;
      if (!room.__gogameObserverSeatHook && typeof room.getIsOb === "function") {
        var originalGetIsOb = room.getIsOb;
        room.getIsOb = function (uid) {
          // The 2.0.1279 client gates empty-seat clicks on getIsOb(). Its
          // params.observed can be missing even while the authoritative room
          // snapshot lists this player in OBmemberList. Preserve the client's
          // normal check, but trust that explicit self observer entry.
          if ((uid === undefined || uid === null) &&
              typeof this.getMyObMemberInfo === "function" && this.getMyObMemberInfo()) {
            return true;
          }
          return originalGetIsOb.apply(this, arguments);
        };
        room.__gogameObserverSeatHook = true;
        step("observer seat state hook");
      }
      var scene = cc.director && cc.director.getScene();
      walkNodes(scene, function (node) {
        var comps = node && node._components || [];
        for (var i = 0; i < comps.length; i++) {
          var comp = comps[i];
          if (!comp || typeof comp.clickSeatDown !== "function" || comp.__gogameSeatClickHook) continue;
          var originalClick = comp.clickSeatDown;
          comp.clickSeatDown = function () {
            step("seat down click");
            return originalClick.apply(this, arguments);
          };
          comp.__gogameSeatClickHook = true;
        }
      });
    } catch (e) {}
  }
  function hookHundredCleanup() {
    try {
      var Cls = getClass("BairenMultyBetViewModel");
      var proto = Cls && Cls.prototype;
      if (!proto || proto.__gogameCleanupHook || typeof proto.sendUnregRoomsReq !== "function") return;
      proto.__gogameCleanupHook = true;
      var original = proto.sendUnregRoomsReq;
      proto.sendUnregRoomsReq = function () {
        function ignoreMissingDomain(err) {
          if (String(err && err.message || err).indexOf("当前没有hundredDomain百人服地址") < 0) throw err;
          step("skip hundred cleanup without hundredDomain");
          return 0;
        }
        try {
          return Promise.resolve(original.apply(this, arguments)).catch(ignoreMissingDomain);
        } catch (err) {
          return Promise.resolve(ignoreMissingDomain(err));
        }
      };
    } catch (e) {}
  }
  var loadedSends = 0;
  function postGameLoaded(scene) {
    if (!scene || HALL_WAIT[scene]) return;
    var active = window.cc && cc.director && cc.director.getScene();
    if (!active || active.name !== scene) return;
    gameActive = true;
    postedLoaded = true;
    var version = entryVersion;
    function send() {
      try {
        if (!currentEntry(version)) return;
        // A delayed retry from the old game must not cover the hall again
        // after the original client has already switched to webHallOb.
        var current = window.cc && cc.director && cc.director.getScene();
        if (!current || current.name !== scene || HALL_WAIT[current.name]) return;
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "gameLoaded" }, "*");
        }
      } catch (e) {}
    }
    if (loadedSends === 0) {
      step("post gameLoaded " + scene);
      send();
      setTimeout(send, 200);
      setTimeout(send, 800);
      setTimeout(send, 2000);
    } else if (loadedSends < 8) {
      send();
    }
    loadedSends += 1;
  }

  var launchSince = 0;
  var forced = false;
  var hallObScene = null;
  var lastSceneLog = "";
  var sceneTimer = setInterval(function () {
    keepConsole();
    if (!window.cc || !cc.director || typeof cc.director.getScene !== "function") return;
    retireReturnedEntry();
    hookWebHallOb();
    hookPersist();
    hookGameUtils();
    hookObserverSeatDown();
    hookHundredCleanup();
    watchLaunchOverlay();
    var scene = cc.director.getScene();
    var name = scene && scene.name;
    if (!name) return;
    if (name === "webHallOb") {
      if (hallObScene !== scene) {
        hallObScene = scene;
        step("scene webHallOb");
        invokeStarts(scene);
      }
      deliverOpenGame("poll");
      if (pendingGame && !sceneReady) loadGameScene(pendingGame);
      return;
    }
    hallObScene = null;
    if (name !== "launch") {
      if (lastSceneLog !== name) {
        lastSceneLog = name;
        step("scene " + name);
      }
      launchSince = 0;
      hideBairenOverlay();
      postGameLoaded(name);
      return;
    }
    if (!launchSince) launchSince = Date.now();
    if (forced || Date.now() - launchSince < 5000) return;
    forced = true;
    step("launch stuck, force webHallOb");
    try {
      var main = cc.assetManager && (cc.assetManager.getBundle("main") || cc.assetManager.main);
      if (main && typeof main.loadScene === "function") {
        main.loadScene("webHallOb", function (err, sc) {
          step("force loadScene " + (err ? String(err) : "ok"));
          if (!err && sc && cc.director.runSceneImmediate) {
            cc.director.runSceneImmediate(sc);
            setTimeout(function () {
              invokeStarts(cc.director.getScene());
              deliverOpenGame("force");
            }, 0);
          }
        });
      }
    } catch (e) {
      step("force webHallOb error " + e);
    }
  }, 200);
})();
</script>`;
