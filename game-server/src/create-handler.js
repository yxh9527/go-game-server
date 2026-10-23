import { rel } from "./rel.js";

export async function createHandler(runtime) {
  const v = runtime.hotVersion;
  const codec = await rel(import.meta.url, "./codec.js", v);
  const messages = await rel(import.meta.url, "./messages.js", v);
  const catalog = await rel(import.meta.url, "./games/catalog.js", v);
  const holdemEngine = await rel(import.meta.url, "./games/holdem/engine.js", v);
  const games = await catalog.loadGames(v);
  const { SEND, PUSH } = messages;

  function gameOf(roomType) {
    return catalog.gameOf(games, roomType);
  }

  function send(ws, msgid, payload) {
    if (ws.readyState === 1) {
      ws.send(codec.encodeFrame(msgid, payload));
    }
  }

  function tableIo(table) {
    return {
      wallet: runtime.wallet,
      send,
      broadcast(msgid, payload) {
        for (const ws of runtime.registry.sessions.keys()) {
          const session = runtime.registry.session(ws);
          if (session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId)) {
            send(ws, msgid, payload);
          }
        }
      },
      sendUser(uid, msgid, payload) {
        // Private action options are valid only for a seated member. An
        // observer must never receive 3426, because the client calculates
        // its all-in amount from a seat and gets null for observers.
        if (msgid === PUSH.DZPK_OPERATION_PUSH
          && !(table.members || []).some((member) => Number(member.uid) === Number(uid))) {
          return;
        }
        for (const ws of runtime.registry.sessions.keys()) {
          const session = runtime.registry.session(ws);
          if (session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId) && Number(session.userId) === Number(uid)) {
            send(ws, msgid, payload);
          }
        }
      },
      forEachPlayer(fn) {
        for (const [ws, session] of runtime.registry.sessions) {
          if (session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId)) {
            fn({ ...session, ws });
          }
        }
      },
    };
  }

  function ctxOf(ws, session, table, body) {
    return {
      runtime,
      io: tableIo(table),
      send: send.bind(null, ws),
      ws,
      session,
      table,
      body,
    };
  }

  function pushPoint(ws, session) {
    send(ws, PUSH.GAME_POINT_UPDATE, { uid: session.userId, point: session.wallet });
  }

  async function persist(session) {
    try {
      await runtime.wallet.persist(session);
    } catch (err) {
      runtime.log.error("save score failed", err.message);
    }
  }

  function ensureTable(roomId, roomType, agentId = 0) {
    const cfg = runtime.findConfig(runtime.configs, roomId, roomType);
    const game = gameOf(roomType) || gameOf(cfg?.room_type);
    let table = game ? runtime.registry.getTable(roomId, agentId, game.id) : null;
    if (table) {
      if (table.agentId == null) table.agentId = Number(agentId) || 0;
      return table;
    }
    if (!game) {
      throw new Error(`no game for roomType=${roomType}`);
    }
    table = game.createTable(roomId, roomType || cfg?.room_type, cfg);
    table.agentId = Number(agentId) || 0;
    return runtime.registry.setTable(roomId, table, agentId, game.id);
  }

  async function onMessage(ws, data) {
    const frame = codec.decodeFrame(data);
    if (!frame) {
      runtime.log.warn?.("[game-server] drop undecoded frame", Buffer.isBuffer(data) ? data.length : typeof data);
      return;
    }
    const { msgid, payload } = frame;
    runtime.log.info?.(`[game-server] << ${msgid}`, payload && typeof payload === "object" ? Object.keys(payload) : payload);
    let session = runtime.registry.session(ws);
    if (msgid === SEND.PING || msgid === SEND.ROOM_PING) {
      send(ws, msgid === SEND.ROOM_PING ? PUSH.ROOM_PING : PUSH.PING);
      return;
    }
    if (msgid === SEND.ROOM_LOGIN) {
      const body = payload || {};
      session = runtime.registry.bind(ws, {
        userId: Number(body.userId || 0),
        name: String(body.userId || "player"),
        clubId: Number(body.clubId || 0),
        roomId: Number(body.roomId || 0),
        wallet: 0,
        agentId: 0,
        topAgentId: 0,
        accumulatedWin: 0,
        accumulatedWinByKind: { GGL1: 0, GGL2: 0 },
      });
      try {
        if (runtime.gateway && (body.userToken || body.token)) {
          const ok = await runtime.gateway.validateToken(body.userToken || body.token, session.userId);
          if (!ok) {
            send(ws, PUSH.ROOM_LOGIN, { serverTime: Date.now(), clubId: 0, enableLog: false, opType: -1 });
            return;
          }
        }
        await runtime.wallet.load(session);
        if (runtime.gateway?.getLoginData) {
          const profile = await runtime.gateway.getLoginData(session.userId);
          session.agentId = Number(profile?.agentId) || 0;
          session.topAgentId = Number(profile?.topAgentId) || 0;
          if (profile?.userName) session.name = String(profile.userName);
        }
      } catch (err) {
        runtime.log.error("login wallet query failed", err.message);
      }
      send(ws, PUSH.ROOM_LOGIN, {
        serverTime: Date.now(),
        clubId: session.clubId,
        roomId: session.roomId,
        enableLog: false,
        opType: 0,
        exchangeRate: 1,
        playerClubId: session.clubId,
        isOpenQuickChange: false,
        openHundredGame: Boolean(body.openHundredGame),
      });
      runtime.log.info?.(`[game-server] room login uid=${session.userId} roomId=${session.roomId}`);
      return;
    }
    if (!session) {
      return;
    }
    if (msgid === SEND.LOGIN_ROOM) {
      const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
      const game = table ? gameOf(table.roomType) : null;
      if (table && game) {
        game.onLoginRoom(ctxOf(ws, session, table, payload || {}));
      }
      return;
    }
    if (msgid === SEND.SEND_JOIN_ROOM) {
      const body = payload || {};
      const roomId = Number(body.roomId || session.roomId);
      const roomType = Number(body.roomType || 0);
      session.roomId = roomId;
      const table = ensureTable(roomId, roomType, session.agentId);
      session.gameId = table.gameId;
      const game = gameOf(table.roomType);
      game.onJoin(ctxOf(ws, session, table, body));
      if (game.kind === "normal") {
        pushPoint(ws, session);
        await persist(session);
      }
      return;
    }
    const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
    if (!table) {
      return;
    }
    const game = gameOf(table.roomType);
    if (msgid === SEND.SEND_LEVEL_OUT) {
      await leaveTable(ws, session, table, game);
      return;
    }
    if (msgid === SEND.SEARCH_MY_POINT) {
      pushPoint(ws, session);
      return;
    }
    if (msgid === SEND.SEND_GAME_SETTING) {
      send(ws, PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: Number(payload?.type || 0) });
      if (typeof game.onLoginRoom === "function") {
        game.onLoginRoom(ctxOf(ws, session, table, payload || {}));
      }
      return;
    }
    if (msgid === SEND.COMMON_SWITCH_REQ) {
      send(ws, PUSH.COMMON_SWITCH_RES, {
        quickChangeState: false,
        globalQuickChangeClose: false,
        opType: Number(payload?.opType || 0),
        setType: Number(payload?.setType || 0),
        openType: 0,
      });
      return;
    }
    const handled = game.onMessage(ctxOf(ws, session, table), msgid, payload || {});
    if (handled && (msgid === SEND.GGL_BUY || msgid === SEND.SEND_CARRY_SCORE || msgid === SEND.SEND_STANDUP)) {
      pushPoint(ws, session);
      await persist(session);
    }
  }

  async function leaveTable(ws, session, table, game) {
    const cash = game.onLeave(ctxOf(ws, session, table));
    session.wallet += Number(cash || 0);
    pushPoint(ws, session);
    await persist(session);
  }

  function tick() {
    for (const table of runtime.registry.tables.values()) {
      const game = gameOf(table.roomType);
      if (game) {
        game.tick({ runtime, io: tableIo(table), table });
      }
      if (table.retired) runtime.registry.removeTable(table.roomId, table.agentId, table.gameId);
    }
  }

  async function onClose(ws) {
    const session = runtime.registry.session(ws);
    if (!session) {
      runtime.registry.drop(ws);
      return;
    }
    const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
    const game = table ? gameOf(table.roomType) : null;
    if (table && game) {
      await leaveTable(ws, session, table, game);
    } else {
      await persist(session);
    }
    runtime.registry.drop(ws);
  }

  function getDevHoldemRecordDetail(roomId, inningNum) {
    if (runtime.env !== "dev") return null;
    const table = runtime.registry.listByRoomType(19).find((item) => Number(item.roomId) === Number(roomId));
    return table ? holdemEngine.texasHistoryDetail(table, inningNum) : null;
  }

  return { onMessage, tick, onClose, games, getDevHoldemRecordDetail };
}
