import express from "express";
import { rel } from "./rel.js";

export async function createApp(runtime) {
  const v = runtime.hotVersion;
  const decode = await rel(import.meta.url, "./decode.js", v);
  const toClient = await rel(import.meta.url, "./to-client.js", v);
  const roomMod = await rel(import.meta.url, "./rooms.js", v);
  const rooms = roomMod.createRoomLogic(decode);

  const app = express();
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
    const userId = decode.num(params.userId ?? req.query.userId, 0);
    const data = await dispatch(op, params, userId);
    res.set("Cache-Control", "no-store").json({ msgCode: 200, errMsg: null, data });
  }

  async function dispatch(op, params, userId) {
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
        return enterRoom(params);
      case 53:
        return loginInfo(params, userId);
      case 54:
        return wallet(userId);
      default:
        return [];
    }
  }

  function listMatches(_params, userId) {
    return runtime.matchStore.listMatches()
      .filter((row) => toClient.isListedMatch(row))
      .sort((a, b) => decode.num(a.sort_index, 0) - decode.num(b.sort_index, 0) || decode.num(a.id, 0) - decode.num(b.id, 0))
      .map((row) => toClient.toClientMatch(row, {
        player: runtime.matchStore.getPlayer(row.id, userId),
        tables: runtime.matchStore.getTables(row.id),
        gameServer: runtime.config.game_server,
      }));
  }

  function matchDetail(params, userId) {
    const id = decode.num(params.championshipsConfigId ?? params.id, 0);
    const row = runtime.matchStore.getMatch(id);
    if (!row) {
      return [];
    }
    return toClient.toClientMatch(row, {
      player: runtime.matchStore.getPlayer(row.id, userId),
      tables: runtime.matchStore.getTables(row.id),
      gameServer: runtime.config.game_server,
    });
  }

  function roomList(params) {
    const gameType = decode.num(params.gameType, 0);
    const selected = rooms.filterRooms(runtime.roomStore.list(), params);
    return [{
      gameType,
      roomClassifications: [],
      roomInfoData: selected.map((row) => toClient.toClientRoom(row)),
      maintenanceInfoMsg: "{\"endDate\":\"\",\"isWhite\":false,\"itemList\":[]}",
      privateRoomOpen: false,
      hundredDomain: runtime.config.hundred_server || null,
      hundredShield: null,
      classifications: null,
    }];
  }

  function enterRoom(params) {
    const row = rooms.findRoom(runtime.roomStore.list(), params);
    if (!row) {
      return [];
    }
    return rooms.enterRoomPayload(row, params, runtime.config);
  }

  async function wallet(userId) {
    let walletAmount = 0;
    let ticketNums = 0;
    if (userId) {
      try {
        walletAmount = Number(await runtime.rpc.common.getBalance(userId)) || 0;
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
    const w = await wallet(uid);
    return {
      userId: uid,
      uid,
      name: userName,
      userToken: token,
      clubId: decode.num(params.clubId, 0),
      gameIp: runtime.config.game_server || "",
      walletAmount: w.walletAmount,
      ticketNums: w.ticketNums,
    };
  }

  const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
  app.get("/internal/v1/do", wrap(handleDo));
  app.get("/api/internal/v1/do", wrap(handleDo));
  app.use((err, _req, res, _next) => {
    runtime.log.error(err);
    res.status(500).json({ msgCode: 500, errMsg: err.message || "error", data: null });
  });
  return app;
}
