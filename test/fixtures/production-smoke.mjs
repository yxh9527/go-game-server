import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const fromBundle = file => import(pathToFileURL(path.join(root, file)).href);
assert.equal(fs.existsSync(path.join(root, "test")), false);
assert.equal(fs.existsSync(path.join(root, "cache")), false);
const { env, loadEnv, RpcAdapter } = await fromBundle("shared/rpc/index.js");
const {importHotModule,collectibleHotStats}=await fromBundle('shared/hot-import.js');
const fromFactory=file=>importHotModule(pathToFileURL(path.join(root,file)).href,'production-smoke');
assert.equal(env.isDev, false, "production is set before the first business-module import");
loadEnv({ env: "dev" });
assert.equal(env.isDev, false, "production launcher overrides a stale dev YAML");
const rpc = new RpcAdapter();
assert.equal(rpc.gateway.constructor.name, "GatewayRpcProd");
assert.equal(rpc.common.constructor.name, "CommonRpcProd");
assert.equal(rpc.lobby.constructor.name, "LobbyRpcProd");
assert.equal(rpc.bus.constructor.name, "BusRpcProd");
const wallets = await fromFactory("game-server/src/wallet/index.js");
assert.throws(() => wallets.createWallet({ mode: "local" }), /only available in dev/);
assert.throws(() => wallets.walletOf({}), /production wallet is required/);
assert.equal(wallets.createWallet({ mode: "online" }).mode, "online");
const { createRegistry } = await fromBundle("game-server/src/registry.js");
const { createHandler } = await fromFactory("game-server/src/create-handler.js");
const registry = createRegistry();
const handler = await createHandler({ env: "prod", hotVersion: "production-smoke", registry,
  configs: [], config: {}, log: console, wallet: wallets.createWallet({}, { rpc }) });
assert.ok(handler.games);
assert.equal(handler.getDevHoldemRecordDetail(1, 1), null);
const engine = await fromBundle("game-server/src/games/holdem/engine.js");
const table = engine.createTexasTable(1, 19, { small_blind: 10, big_blind: 20 });
table.history.push({ currentInningNum: 1, firstGameList: [], secondGameList: [] });
assert.equal(engine.texasHistoryDetail(table, 1), null);
assert.equal(engine.texasHistoryPayload(table).totalNum, 0);
const web = await fromBundle("hall/src/web.js");
assert.equal(web.HALL_DEV_PATCH, "");
const { createMatchStore, createRoomStore } = await fromBundle("hall/src/store.js");
const { createApp } = await fromFactory("hall/src/create-app.js");
const roomStore = createRoomStore();
roomStore.replace([{ game_type: 1004, room_type: 61, game_room_config_id: 6101, carry_min: 500, state: 1 }]);
const hall = await createApp({ env: "prod", hotVersion: "production-smoke", config: {},
  matchStore: createMatchStore(), roomStore, log: console });
const { createClientApp } = await fromFactory("client-web/src/app.js");
const match = await fromFactory("match/src/create-app.js");
await match.createApp({ env: "prod", hotVersion: "production-smoke", config: {}, store: {}, bus: {} });
// The detail reader is lazy in the hall; exercise it before counting the full
// selected production graph, without making a database/history request.
assert.equal(typeof (await fromFactory('shared/game-history-detail.js')).queryGameHistoryDetail,'function');
// This smoke runtime does not activate the production ticket branch; load its
// selected factories explicitly without buying a ticket or querying storage.
assert.equal(typeof (await fromFactory('game-server/src/core/slots-reels.js')).compileReels,'function');
assert.equal(typeof (await fromFactory('game-server/src/games/ggl-core/rpc-tickets.js')).createRpcScratchTickets,'function');
assert.equal(typeof (await fromFactory('game-server/src/games/ggl-core/reel-profile.js')).scratchReelProfile,'function');
assert.equal(typeof (await fromFactory('game-server/src/wallet/transaction-state.js')).captureGameState,'function');
for(const [file,name]of [['rpcWallet.js','createRpcWallet'],['authoritative.js','createAuthoritativeWallet'],['round-finance.js','createRoundFinance']])assert.equal(typeof (await fromFactory('game-server/src/wallet/'+file))[name],'function');
assert.equal(typeof (await fromFactory('shared/user-center-matches.js')).userCenterMatch,'function');
assert.equal(typeof (await fromFactory('shared/tournament-snapshot.js')).tournamentSnapshot,'function');
assert.equal(typeof (await fromFactory('game-server/src/core/hundred-lobby.js')).listHundredLobbyRooms,'function');
// Cover every selected module, including lazy config and compatibility paths.
const {collectibleModuleFiles}=await fromBundle('shared/hot-entry-factory.js');
for(const file of collectibleModuleFiles)await fromFactory(path.relative(root,file));
assert.equal(collectibleHotStats().activeEntries,242);
assert.equal(collectibleHotStats().compiledEntries,242);
assert.equal(collectibleHotStats().compileFailures,0);
for (const [app, url] of [[hall, "/21/0?userId=1&userToken=smoke&openId=1&v=2.0.1279"],
  [hall, "/api/internal/v1/do?op=38&gameType=1004"], [createClientApp(), "/2.0.1279/"]]) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await new Promise((resolve, reject) => {
      http.get({ hostname: "127.0.0.1", port: server.address().port, path: url, headers: { Host: "lobby.example.com" } }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }).on("error", reject);
    });
    assert.equal(response.status, 200, "isolated smoke request must not redirect to a running dev service");
    assert.doesNotMatch(response.body, /GOGAME-DEV|GOGAME-HALL|skip hundred cleanup/);
    if (url.includes("op=38")) {
      const body = JSON.parse(response.body);
      assert.equal(body.msgCode, 200);
      const count = body.data[0].roomInfoData[0].totalPeople;
      assert.ok(Number.isSafeInteger(count) && count > 0, "shared population is available without dev cache");
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
console.log("production modules and HTTP apps work without test/cache");
