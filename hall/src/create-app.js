import express from "express";
import { rel } from "./rel.js";

export async function createApp(runtime) {
  const v = runtime.hotVersion;
  if(runtime.env==='prod'){
    const {refreshDataAccess}=await rel(import.meta.url,'../../shared/rpc/adapters/rpcAdapter.js',v);
    await refreshDataAccess(runtime);
  }
  if (runtime.env === "dev") {
    const localConfigs = await rel(import.meta.url, "../../cache/rpc/room-configs.js", v);
    await localConfigs.refreshRoomConfigs(runtime);
  }
  const decode = await rel(import.meta.url, "./decode.js", v);
  const toClient = await rel(import.meta.url, "./to-client.js", v);
  const roomMod = await rel(import.meta.url, "./rooms.js", v);
  const web = await rel(import.meta.url, "./web.js", v);
  const fairCode = await rel(import.meta.url, "./fair-code.js", v);
  const smartBet = await rel(import.meta.url, "./smart-bet.js", v);
  const { matchRequest } = await rel(import.meta.url, './match-client.js', v);
  if(!runtime.matchStore.supportsTournamentSnapshots||!runtime.matchStore.getPlayers){
    // Existing listeners retain this object; upgrade methods in place on hot reload.
    const {createMatchStore}=await rel(import.meta.url,'./store.js',v),next=createMatchStore();
    const rows=runtime.matchStore.listMatches();next.replaceMatches(rows);
    next.replaceTables(rows.flatMap(r=>runtime.matchStore.getTables(r.id)));
    next.replacePlayers(await runtime.rpc?.lobby?.listMatchPlayers?.()||[]);
    Object.assign(runtime.matchStore,next);
  }
  const roomPool = await rel(import.meta.url, "./room-pool.js", v);
  const populationMod = await rel(import.meta.url, "./room-population.js", v);
  const { assertHoldemPlayable } = await rel(import.meta.url, "../../shared/holdem-room.js", v);
  const population = await populationMod.createRoomPopulation(runtime.config.room_population, v);
  const rooms = roomMod.createRoomLogic(decode);
  const localRecords = runtime.env === "dev"
    ? await rel(import.meta.url, "../../cache/hall/record-detail.js", v)
    : null;

  const app = express();
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Vary", "Origin");
    } else {
      res.set("Access-Control-Allow-Origin", "*");
    }
    res.set("Access-Control-Allow-Credentials", "true");
    res.set("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, Authorization, X-Requested-With, token");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_req, res) => {
    res.json({
      code: 0,
      msg: "ok",
      data: {
        service: "hall",
        env: runtime.env,
        hotVersion: v,
        matches: runtime.matchStore.listMatches().length,
        rooms: runtime.roomStore.list().length,
      },
    });
  });

  async function handleDo(req, res) {
    const params = {
      ...decode.decodeParams(req.query.param),
      ...req.query,
    };
    const op = decode.num(params.op, 0);
    delete params._matchAgent;
    if([35,36].includes(op)){
      const gateway=runtime.gateway||runtime.rpc?.gateway,uid=Number(params.userId),token=params.token||params.userToken;
      if(gateway&&uid>0&&token){
        const auth=await gateway.authenticate(token,uid);
        if(!auth.success||Number(auth.userId)!==uid){res.json({msgCode:401,errMsg:'登录凭证无效',data:null});return;}
        const profile=await gateway.getLoginData(uid);params._matchAgent=Number(profile.agentId);
      }else if(runtime.env==='dev')params._matchAgent=1;
      else {res.json({msgCode:401,errMsg:'缺少登录凭证',data:null});return;}
    }
    if ([42,43,48].includes(op)) {
      try {
        if(op===48)throw Object.assign(new Error('比赛重入功能尚未开放'),{code:503});
        if(op===42&&Number(params.type)!==2)throw Object.assign(new Error('该报名支付方式尚未开放'),{code:400});
        await matchRequest(runtime,params,op===43?'unregister':'register');
        res.set('Cache-Control','no-store').json({msgCode:200,errMsg:null,data:[]});
      } catch(error) {
        res.set('Cache-Control','no-store').json({msgCode:error.code||503,errMsg:error.message,data:null});
      }
      return;
    }
    if (op === 71) {
      res.set("Cache-Control", "no-store").json(smartBet.smartBetResponse(params));
      return;
    }
    if (op === 29) {
      res.set("Cache-Control", "no-store").json(await fairCode.requestFairCode(runtime, params));
      return;
    }
    if (op === 46 && runtime.env === "dev") {
      const gameRoomId = decode.num(params.gameRoomId, 0);
      const inningNum = decode.num(params.inningNum, 0);
      const data = await localRecords.getDevHoldemRecordDetail(runtime, gameRoomId, inningNum, params);
      res.set("Cache-Control", "no-store").json(data
        ? { msgCode: 200, errMsg: null, data }
        : { msgCode: 404, errMsg: "开发环境没有找到这局牌的详情记录", data: null });
      return;
    }
    const userId = decode.num(params.userId ?? req.query.userId, 0);
    let data;
    try {
      // Separate dev processes have separate in-memory buses. Production receives Redis snapshots.
      if(runtime.env==='dev'&&[35,36].includes(op)&&params.userId&&(params.token||params.userToken)) {
        try { await matchRequest(runtime,params); } catch(error) { runtime.log.error('dev match refresh failed',error.message); }
      }
      data = await dispatch(op, params, userId, req);
    } catch (error) {
      if ((op === 38 || op === 45) && error.code) {
        res.set("Cache-Control", "no-store").json({ msgCode: error.code, errMsg: error.message, data: null });
        return;
      }
      throw error;
    }
    res.set("Cache-Control", "no-store").json({ msgCode: 200, errMsg: null, data });
  }

  async function dispatch(op, params, userId, req) {
    switch (op) {
      case 35:
        return listMatches(params, userId);
      case 36:
        return matchDetail(params, userId);
      case 38:
        return roomList(params);
      case 42:
        return [];
      case 44:
      case 62:
      case 63:
        return [];
      case 45:
        return enterRoom(params, req);
      case 49:
        return { clubId: 0, type: decode.num(params.type, 1), roomType: decode.num(params.roomType, 0), itemList: [] };
      case 53:
        return loginInfo(params, userId);
      case 54:
        return wallet(userId,params);
      default:
        return [];
    }
  }

  function listMatches(params, userId) {
    return runtime.matchStore.listMatches()
      .filter(row=>Number(row.agent_id||(runtime.env==='dev'?1:0))===params._matchAgent)
      .filter((row) => toClient.isListedMatch(row))
      .sort((a, b) => decode.num(a.sort_index, 0) - decode.num(b.sort_index, 0) || decode.num(a.id, 0) - decode.num(b.id, 0))
      .map((row) => toClient.toClientMatch(row, {
        player: runtime.matchStore.getPlayer(row.id, userId),
        players:runtime.matchStore.getPlayers(row.id),
        tables: runtime.matchStore.getTables(row.id),
        gameServer: runtime.config.game_server,
      }));
  }

  function matchDetail(params, userId) {
    const id = decode.num(params.championshipsConfigId ?? params.id, 0);
    const row = runtime.matchStore.getMatch(id);
    if (!row || Number(row.agent_id||(runtime.env==='dev'?1:0))!==params._matchAgent) {
      return [];
    }
    return toClient.toClientMatch(row, {
      player: runtime.matchStore.getPlayer(row.id, userId),
      players:runtime.matchStore.getPlayers(row.id),
      tables: runtime.matchStore.getTables(row.id),
      gameServer: runtime.config.game_server,
    });
  }

  async function roomList(params) {
    const gameType = decode.num(params.gameType, 0);
    const selected = rooms.filterRooms(runtime.roomStore.list(), params);
    // Display population is shared by all games. Real occupancy is consulted
    // only when disabled; listing never creates or wakes a game room.
    const poolRooms = !population.enabled && selected.some((row) => [19, 24, 25, 32].includes(Number(row.room_type)))
      && params.userId && (params.token || params.userToken)
      ? await roomPool.requestRoomPool(runtime, params, "list") : [];
    const hundredRooms = selected.some(row => [1000, 1001, 1002, 1003].includes(Number(row.game_type)))
      && params.userId && (params.token || params.userToken) && (runtime.config.hundred_server || runtime.config.game_server)
      ? await roomPool.requestRoomPool(runtime, params, "hundred-list", {
        gameType, ...(params.roomType ? { roomType: Number(params.roomType) } : {}),
      }) : [];
    const now = Date.now();
    return [{
      gameType,
      roomClassifications: [],
      roomInfoData: selected.map((row) => {
        const result = toClient.toClientRoom(row);
        const liveHundred = hundredRooms.find(room => room.gameRoomConfigId === Number(row.game_room_config_id)
          && room.roomType === Number(row.room_type) && room.roomIndex === Number(row.room_index || 0));
        if (liveHundred) Object.assign(result, liveHundred);
        if (!population.enabled && [19, 24, 25, 32].includes(Number(row.room_type))) {
          const live = poolRooms.filter((table) => table.gameRoomConfigId === Number(row.game_room_config_id)
            && table.roomType === Number(row.room_type));
          result.totalPeople = live.reduce((sum, table) => sum + table.totalPeople, 0);
        }
        return population.decorate(result, row, now);
      }),
      maintenanceInfoMsg: "{\"endDate\":\"\",\"isWhite\":false,\"itemList\":[]}",
      privateRoomOpen: false,
      hundredDomain: runtime.config.hundred_server || null,
      hundredShield: null,
      classifications: null,
    }];
  }

  async function enterRoom(params, req) {
    const selected = rooms.findRoom(runtime.roomStore.list(), params);
    if (!selected) {
      return [];
    }
    const openHundredGame = [50, 51, 52, 60, 62].includes(Number(selected.room_type));
    const row = openHundredGame ? rooms.hundredHostRoom(runtime.roomStore.list(), selected.room_type) : selected;
    if (!row) throw new Error('No ordinary room is configured for this hundred-game host');
    if (Number(row.room_type) === 19) assertHoldemPlayable(row);
    const domain = web.publicWsHost(req, runtime.config, runtime.env);
    const payload = rooms.enterRoomPayload(row, openHundredGame ? {} : params, {
      ...runtime.config,
      game_server: domain,
      hundred_server: web.publicHundredWsHost(req, runtime.config, runtime.env),
    });
    if (openHundredGame) payload.openHundredGame = true;
    if ([19, 24, 25, 32].includes(Number(row.room_type))) {
      const allocation = await roomPool.requestRoomPool(runtime, params, "allocate", {
        gameRoomConfigId: Number(row.game_room_config_id), roomType: Number(row.room_type),
        roomIndex: openHundredGame ? row.room_index ?? 0 : params.roomIndex ?? row.room_index ?? 0,
      });
      return { ...payload, roomId: allocation.roomId, roomType: allocation.roomType,
        roomIndex: allocation.roomIndex, gameRoomConfigId: allocation.gameRoomConfigId,
        playMode: allocation.playMode };
    }
    return payload;
  }

  async function wallet(userId,params={}) {
    let walletAmount = 0;
    let ticketNums = 0;
    if (userId) {
      try {
        if(runtime.env==='dev' && runtime.config.game_server && (params.token||params.userToken)) {
          walletAmount=Number((await roomPool.requestRoomPool(runtime,{...params,userId},'wallet')).walletAmount)||0;
        }else walletAmount = Number(await runtime.rpc.common.getBalance(userId)) || 0;
      } catch (err) {
        runtime.log.error("wallet balance failed", err.message);
      }
      try {
        ticketNums = Number(await runtime.rpc.lobby.countUnusedTickets(userId)) || 0;
      } catch (err) {
        runtime.log.error("wallet ticket query failed", err.message);
      }
    }
    return { walletAmount, ticketNums };
  }

  async function loginInfo(params, userId) {
    const token = params.token || params.userToken || "";
    let uid = userId;
    let userName = "";
    if (runtime.gateway) {
      const auth = await runtime.gateway.authenticate(token, userId);
      if (!auth.success) {
        return { userId: 0, uid: 0, userToken: token, clubId: 0, gameIp: runtime.config.game_server || "", walletAmount: 0, ticketNums: 0, errMsg: auth.message };
      }
      uid = auth.userId || userId;
      const profile = await runtime.gateway.getLoginData(uid);
      userName = profile.userName || "";
    }
    const w = await wallet(uid,params);
    return {
      userId: uid,
      uid,
      name: userName,
      userToken: token || `dev-${uid}`,
      openId: params.openId || String(uid || ""),
      clubId: decode.num(params.clubId, 0),
      hideGameMenus: null,
      walletAmount: w.walletAmount,
      ticketNums: w.ticketNums,
    };
  }

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  app.get("/internal/v1/do", wrap(handleDo));
  app.get("/api/internal/v1/do", wrap(handleDo));
  web.mountWeb(app, runtime);
  app.use((err, _req, res, _next) => {
    runtime.log.error(err);
    res.status(500).json({ msgCode: 500, errMsg: err.message || "error", data: null });
  });
  return app;
}
