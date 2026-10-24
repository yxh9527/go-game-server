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

