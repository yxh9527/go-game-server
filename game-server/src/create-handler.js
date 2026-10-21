import { rel } from "./rel.js";

export async function createHandler(runtime) {
  const v = runtime.hotVersion;
  const codec = await rel(import.meta.url, "./codec.js", v);
  const messages = await rel(import.meta.url, "./messages.js", v);
  const catalog = await rel(import.meta.url, "./games/catalog.js", v);
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
          if (session?.roomId === table.roomId) {
            send(ws, msgid, payload);
          }
        }
      },
      forEachPlayer(fn) {
        for (const [ws, session] of runtime.registry.sessions) {
          if (session?.roomId === table.roomId) {
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

  function ensureTable(roomId, roomType) {
    let table = runtime.registry.getTable(roomId);
    if (table) {
      return table;
    }
    const cfg = runtime.findConfig(runtime.configs, roomId, roomType);
    const game = gameOf(roomType) || gameOf(cfg?.room_type);
    if (!game) {
      throw new Error(`no game for roomType=${roomType}`);
    }
    table = game.createTable(roomId, roomType || cfg?.room_type, cfg);
    return runtime.registry.setTable(roomId, table);
  }

  async function onMessage(ws, data) {
    const frame = codec.decodeFrame(data);
    if (!frame) {
      return;
    }
    const { msgid, payload } = frame;
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
      } catch (err) {
        runtime.log.error("login wallet query failed", err.message);
      }
      send(ws, PUSH.ROOM_LOGIN, {
        serverTime: Date.now(),
        clubId: session.clubId,
        enableLog: false,
        opType: 0,
        exchangeRate: 1,
        playerClubId: session.clubId,
        isOpenQuickChange: false,
        openHundredGame: Boolean(body.openHundredGame),
      });
      return;
    }
    if (!session) {
      return;
    }
    if (msgid === SEND.SEND_JOIN_ROOM) {
      const body = payload || {};
      const roomId = Number(body.roomId || session.roomId);
      const roomType = Number(body.roomType || 0);
      session.roomId = roomId;
      const table = ensureTable(roomId, roomType);
      const game = gameOf(table.roomType);
      game.onJoin(ctxOf(ws, session, table, body));
      if (game.kind === "normal") {
        pushPoint(ws, session);
        await persist(session);
      }
      return;
    }
    const table = runtime.registry.getTable(session.roomId);
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
    if (handled && msgid === SEND.GGL_BUY) {
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
    }
  }

  async function onClose(ws) {
    const session = runtime.registry.session(ws);
    if (!session) {
      runtime.registry.drop(ws);
      return;
    }
    const table = runtime.registry.getTable(session.roomId);
    const game = table ? gameOf(table.roomType) : null;
    if (table && game) {
      await leaveTable(ws, session, table, game);
    } else {
      await persist(session);
    }
    runtime.registry.drop(ws);
  }

  return { onMessage, tick, onClose, games };
}
