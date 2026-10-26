import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import test from "node:test";
import vm from "node:vm";
import { adaptRoomListRefresh } from "../../hall/src/room-list-refresh.js";
import { createApp } from "../../hall/src/create-app.js";

const bundle = "434-da255fd00b51666b.js";
const source = fs.readFileSync(new URL("../../static/hall/_next/static/chunks/" + bundle, import.meta.url), "utf8");

// Execute the supplied component and its real polling effect with controlled
// React hooks/time/network. The original UI state must consume the response.
function componentHarness(input = source) {
  const chunks = [], timers = new Map(), listeners = new Map(), states = [], refs = [], effects = [];
  const requests = [];
  const document = { hidden: false, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  let stateIndex = 0, refIndex = 0, mounted = false, timerId = 0;
  let response = async () => ({ roomInfoData: [{ roomType: 19, carryMin: 500, totalPeople: 27 }] });
  const window = { setInterval(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearInterval(id) { timers.delete(id); } };
  vm.runInNewContext(input, { self: { webpackChunk_N_E: chunks }, document, window });
  const react = {
    memo: fn => fn,
    useState(initial) { const index = stateIndex++; if (!mounted) states[index] = typeof initial === "function" ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
    useRef(initial) { const index = refIndex++; return refs[index] ??= { current: initial }; },
    useEffect(fn) { if (!mounted) effects.push(fn); },
  };
  const jsx = (type, props) => ({ type, props });
  const generic = new Proxy({}, { get: (_target, name) => name === "Lh" ? () => true : () => null });
  const modules = {
    5868: react, 7876: { jsx, jsxs: jsx, Fragment: "fragment" }, 8847: () => () => null,
    3596: { ir: () => false },
    4988: { Tx: (gameType, subTypeIndex) => ({ op: gameType === 19 && subTypeIndex === 1 ? 35 : 38, gameType, subTypeIndex }),
      no: (gameType, subTypeIndex) => gameType === 19 && subTypeIndex === 1, H9: () => null },
    3313: { async s6(params, options) { requests.push({ params, options }); return response(); } },
    5916: new Proxy({}, { get: (_target, name) => name }),
  };
  const require = id => modules[id] ?? generic;
  require.d = (target, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }); };
  require.n = value => () => value;
  const exports = {};
  chunks[0][1][8057]({}, exports, require);
  const props = { roomInfoData: [{ roomType: 19, carryMin: 500, totalPeople: 9 }], gameType: 19, subTypeIndex: 0,
    maintenanceGameTypeList: [], maintenanceEndDate: "" };
  const cleanups = [];
  function render() { stateIndex = 0; refIndex = 0; return exports.A(props); }
  return { document, requests, timers, listeners, props, states,
    setResponse(fn) { response = fn; }, render,
    mount() { render(); mounted = true; for (const fn of effects) { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); } },
    unmount() { for (const cleanup of cleanups) cleanup(); },
    tick() { assert.equal(timers.size, 1); return [...timers.values()][0].fn(); },
  };
}

test("original ordinary list does not poll; adapted component updates actual displayed population", async () => {
  const original = componentHarness(); original.mount();
  assert.equal(original.timers.size, 0);
  const adapted = componentHarness(adaptRoomListRefresh(source)); adapted.mount();
  assert.equal([...adapted.timers.values()][0].delay, 5000);
  await adapted.tick();
  assert.equal(adapted.requests[0].params.op, 38);
  assert.equal(adapted.requests[0].options.silent, true);
  const spans = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node.type === "span" && node.props?.className === "people") spans.push(node.props.children.at(-1));
    visit(node.props?.children);
  };
  visit(adapted.render());
  assert.deepEqual(spans, [27], "render consumes newly fetched totalPeople");
  adapted.unmount();
  assert.equal(adapted.timers.size, 0);
  assert.equal(adapted.listeners.size, 0);
});

test("common refresh covers all room-list types and excludes tournament requests", async () => {
  for (const gameType of [19, 21, 26, 28, 31, 1000, 1002, 1004, 54321]) {
    const h = componentHarness(adaptRoomListRefresh(source)); h.props.gameType = gameType; h.mount();
    await h.tick();
    assert.equal(h.requests[0].params.gameType, gameType);
    assert.equal(h.requests.length, 1);
    h.unmount();
  }
  const h = componentHarness(adaptRoomListRefresh(source)); h.props.subTypeIndex = 1; h.mount();
  assert.equal(h.timers.size, 0);
  assert.equal(h.requests.length, 0);
});

test("existing hidden-page, pending-request and unmount guards remain effective", async () => {
  const h = componentHarness(adaptRoomListRefresh(source)); h.mount();
  h.document.hidden = true; await h.tick(); assert.equal(h.requests.length, 0);
  h.document.hidden = false;
  let resolve;
  h.setResponse(() => new Promise(done => { resolve = done; }));
  const pending = h.tick(); await h.tick(); assert.equal(h.requests.length, 1);
  h.unmount();
  resolve({ roomInfoData: [{ totalPeople: 88 }] }); await pending;
  assert.equal(h.states[0], null, "late response cannot update an unmounted list");
});

test("hall serves the adapted bundle without changing the static source file", async (t) => {
  const app = await createApp({ env: "prod", hotVersion: "room-refresh-http", config: {}, log: console,
    matchStore: { listMatches: () => [] }, roomStore: { list: () => [] } });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch("http://127.0.0.1:" + server.address().port + "/_next/static/chunks/" + bundle,
    { headers: { Host: "lobby.example.com" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await response.text(), adaptRoomListRefresh(source));
  assert.equal(fs.readFileSync(new URL("../../static/hall/_next/static/chunks/" + bundle, import.meta.url), "utf8"), source);
  assert.throws(() => adaptRoomListRefresh("unrelated client"), /layout changed/);
});
