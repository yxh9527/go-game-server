import { rel } from "./rel.js";

export async function createHandler(runtime) {
  const v = runtime.hotVersion;
  const codec = await rel(import.meta.url, "./codec.js", v);
  const messages = await rel(import.meta.url, "./messages.js", v);
  const catalog = await rel(import.meta.url, "./games/catalog.js", v);
  const holdemEngine = await rel(import.meta.url, "./games/holdem/engine.js", v);
  const games = await catalog.loadGames(v);
  const fair = await rel(import.meta.url, "./core/fair-code.js", v);
  const lifecycle = await rel(import.meta.url, "./core/room-lifecycle.js", v);
  const poolModule = await rel(import.meta.url, "./core/room-pool.js", v);
  const features = await rel(import.meta.url, "./core/room-features.js", v);
  const localHttp = runtime.env === "dev"
    ? await rel(import.meta.url, "../../cache/game-server/http.js", v)
    : null;
  const { SEND, PUSH } = messages;
  const pool = poolModule.createRoomPool(runtime, gameOf);
  for (const table of runtime.registry.tables.values()) {
    if (table.kind === "normal") {
      features.initializeRoomStats(table);
      features.syncMembers(table);
    }
  }

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
      env: runtime.env,
      wallet: runtime.wallet,
      send,
      sessionFor(uid) {
        return [...runtime.registry.sessions.values()].find((session) => session.inRoom !== false
          && Number(session.userId) === Number(uid) && Number(session.roomId) === Number(table.roomId)
          && Number(session.agentId || 0) === Number(table.agentId || 0)
          && String(session.gameId || table.gameId) === String(table.gameId));
      },
      broadcast(msgid, payload) {
        for (const ws of runtime.registry.sessions.keys()) {
          const session = runtime.registry.session(ws);
          if (session?.inRoom !== false && session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId)) {
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
          if (session?.inRoom !== false && session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId) && Number(session.userId) === Number(uid)) {
            send(ws, msgid, payload);
          }
        }
      },
      forEachPlayer(fn) {
        for (const [ws, session] of runtime.registry.sessions) {
          if (session?.inRoom !== false && session?.roomId === table.roomId && Number(session.agentId || 0) === Number(table.agentId || 0) && String(session.gameId || table.gameId) === String(table.gameId)) {
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
    if (pool.wasAllocated(roomId, roomType || cfg?.room_type, agentId, cfg)) return null;
    table = game.createTable(roomId, roomType || cfg?.room_type, cfg);
    table.agentId = Number(agentId) || 0;
    runtime.registry.setTable(roomId, table, agentId, game.id);
    pool.track(table);
    return table;
  }

  // hall-to-game internal query uses JSON on the existing socket listener.
  // It never binds a room session and never uses invented client message IDs.
  async function internalRoomPool(ws, body) {
    const respond = (payload) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: "room-pool-result", ...payload }));
    };
    try {
      const uid = Number(body.userId);
      if (!Number.isSafeInteger(uid) || uid <= 0 || !runtime.gateway?.validateToken
        || !await runtime.gateway.validateToken(body.token, uid)) {
        respond({ code: 401, error: "登录凭证无效" });
        return;
      }
      const profile = await runtime.gateway.getLoginData(uid);
      const agentId = Number(profile?.agentId) || 0;
      if (body.action === "list") {
        respond({ code: 200, data: pool.list(agentId) });
        return;
      }
      if (body.action !== "allocate") {
        respond({ code: 400, error: "无效房间操作" });
        return;
      }
      const cfg = (runtime.configs || []).find((row) => Number(row.state ?? 1) === 1
        && Number(row.game_room_config_id) === Number(body.gameRoomConfigId)
        && Number(row.room_type) === Number(body.roomType));
      if (!cfg) {
        respond({ code: 404, error: "未找到房间配置" });
        return;
      }
      respond({ code: 200, data: pool.allocate(agentId, cfg, body.roomIndex) });
    } catch (error) {
      runtime.log.error("room pool query failed", error.message);
      respond({ code: 503, error: "房间暂不可用" });
    }
  }

  function expireRoom(table, now = Date.now()) {
    if (table.phase === "playing") return Promise.resolve();
    if (table.closureTask) return table.closureTask;
    const closure = lifecycle.prepareClosure(table, now);
    if (!closure.sessions) {
      closure.sessions = [...runtime.registry.sessions].filter(([, session]) => session.inRoom !== false
        && Number(session.roomId) === Number(table.roomId)
        && Number(session.agentId || 0) === Number(table.agentId || 0)
        && String(session.gameId || table.gameId) === String(table.gameId));
      for (const [, session] of closure.sessions) {
        session.inRoom = false;
        session.roomClosing = true;
      }
    }
    const task = (async () => {
      for (const payout of closure.payouts.values()) {
        if (!payout.session) {
          payout.session = closure.sessions.find(([, session]) => Number(session.userId) === payout.uid)?.[1]
            || [...runtime.registry.sessions.values()].find((session) => Number(session.userId) === payout.uid
              && Number(session.agentId || 0) === Number(table.agentId || 0));
          if (!payout.session) {
            const session = { userId: payout.uid, agentId: table.agentId, wallet: 0 };
            await runtime.wallet.load(session);
            payout.session = session;
          }
        }
        if (!payout.credited) {
          const result = runtime.wallet.credit
            ? await runtime.wallet.credit(payout.session, payout.amount)
            : (payout.session.wallet += payout.amount, { ok: true });
          if (result?.ok === false) throw new Error("Room refund rejected");
          payout.credited = true;
          const member = table.members.find((item) => Number(item.uid) === payout.uid);
          if (member) features.recordCarryOut(table, member, payout.amount);
        }
        if (!payout.persisted) {
          await runtime.wallet.persist(payout.session);
          payout.persisted = true;
        }
      }
      for (const [socket, session] of closure.sessions) {
        const payout = closure.payouts.get(Number(session.userId));
        if (payout) session.wallet = payout.session.wallet;
        pushPoint(socket, session);
        send(socket, PUSH.ROOM_DISSMISS, { roomId: table.roomId });
        session.roomClosing = false;
      }
      // Clear only after every refund is recorded. Failures retain a retryable
      // closed table; no new hand or player action can change its balances.
      table.members = [];
      table.observers = [];
      table.hand = null;
      table.history = [];
      table.fairCodes?.clear();
      table.roomFeatures?.players.clear();
      delete table.roomFeatures;
      table.robotTraffic?.profiles.clear();
      delete table.robotTraffic;
      delete table.suspendedAt;
      delete table.emptySinceHands;
      delete table.humanPresenceSeen;
      if (runtime.registry.getTable(table.roomId, table.agentId, table.gameId) === table) {
        runtime.registry.removeTable(table.roomId, table.agentId, table.gameId);
      }
    })();
    table.closureTask = task;
    task.catch((error) => runtime.log.error("room expiry refund failed; will retry", error.message))
      .finally(() => { delete table.closureTask; });
    return task;
  }

  async function onMessage(ws, data) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (raw[0] === 0x7b) {
      if (raw.length > 8192) return;
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (body?.type === "room-pool") await internalRoomPool(ws, body);
      return;
    }
    const frame = codec.decodeFrame(data);
    if (!frame) {
      runtime.log.warn?.("[game-server] drop undecoded frame", Buffer.isBuffer(data) ? data.length : typeof data);
      return;
    }
    const { msgid, payload } = frame;
    runtime.log.info?.(`[game-server] << ${msgid}`, payload && typeof payload === "object" ? Object.keys(payload) : payload);
    let session = runtime.registry.session(ws);
    if (session?.roomClosing) return;
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
        inRoom: false,
        authenticated: false,
        accumulatedWinByKind: { GGL1: 0, GGL2: 0 },
      });
      try {
        if (runtime.gateway?.validateToken) {
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
          session.icon = profile?.icon ?? profile?.userIcon;
        }
        session.authenticated = true;
      } catch (err) {
        runtime.log.error("login wallet query failed", err.message);
        send(ws, PUSH.ROOM_LOGIN, { serverTime: Date.now(), clubId: 0, enableLog: false, opType: -1 });
        return;
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
    if (session.authenticated === false) return;
    if (msgid === SEND.MB_UNREG_ROOMS_REQ) {
      // The shared Bairen client sends this even without any subscriptions,
      // and often after 2110 has detached the primary room. No room lookup,
      // join, wallet operation or main-table leave belongs to this cleanup.
      // There are currently no multi-room subscriptions in this handler.
      send(ws, PUSH.MB_UNREG_ROOMS_RES, {});
      return;
    }
    if (msgid === SEND.SEND_BLOCKCHAIN_VERIFY || msgid === SEND.SEND_BLOCKCHAIN_INFO) {
      const roomId = Number(payload?.gameRoomId || session.roomId);
      const candidates = runtime.registry.listAgentGameRooms(session.agentId)
        .filter((item) => Number(item.roomId) === roomId && (payload?.roomType == null || Number(item.roomType) === Number(payload.roomType)));
      const table = candidates.length === 1 ? candidates[0] : null;
      // Sessions established before this hot update have no authentication flag;
      // newly created sessions always start false until login succeeds.
      const allowed = session.authenticated !== false && table
        && !table.closing;
      if (msgid === SEND.SEND_BLOCKCHAIN_VERIFY) {
        send(ws, PUSH.DZPK_RESULT_BLOCKCHAIN_VERIFY, allowed ? fair.fairCodeList(table, session.userId) : []);
      } else {
        const data = allowed ? fair.fairCodeDetail(table, session.userId, payload?.currentInning) : null;
        send(ws, PUSH.DZPK_RESULT_BLOCKCHAIN_INFO, data || { currentInning: Number(payload?.currentInning) || 0, notarizationCode: "", pokerList: [], roomConfig: "{}" });
      }
      return;
    }
    if (msgid === SEND.LOGIN_ROOM) {
      const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
      const game = table ? gameOf(table.roomType) : null;
      if (table && game) await game.afterRound?.(ctxOf(ws, session, table));
      if (table?.kind === "normal" && lifecycle.isExpired(table) && table.phase !== "playing") {
        await expireRoom(table);
        return;
      }
      if (table && game && session.inRoom !== false) {
        game.onLoginRoom(ctxOf(ws, session, table, payload || {}));
        const code = fair.currentFairCode(table, session.userId);
        if (code) send(ws, PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY, code);
      }
      return;
    }
    if (msgid === SEND.SEND_JOIN_ROOM) {
      const body = payload || {};
      const roomId = Number(body.roomId || session.roomId);
      const roomType = Number(body.roomType || 0);
      session.roomId = roomId;
      const table = ensureTable(roomId, roomType, session.agentId);
      if (!table) {
        send(ws, PUSH.ROOM_DISSMISS, { roomId });
        return;
      }
      await gameOf(table.roomType)?.afterRound?.(ctxOf(ws, session, table));
      if (table.kind === "normal" && lifecycle.isExpired(table)) {
        await expireRoom(table);
        send(ws, PUSH.ROOM_DISSMISS, { roomId: table.roomId });
        return;
      }
      session.gameId = table.gameId;
      session.inRoom = true;
      table.standby = false;
      const game = gameOf(table.roomType);
      game.onJoin(ctxOf(ws, session, table, body));
      const code = fair.currentFairCode(table, session.userId);
      if (code) send(ws, PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY, code);
      if (game.kind === "normal") {
        pool.expand();
        pushPoint(ws, session);
        await persist(session);
      }
      return;
    }
    // An explicit exit is acknowledged directly, never via room broadcast:
    // inRoom=false intentionally stops subsequent room traffic to this socket.
    // Also recover clients whose earlier exit completed without its receipt.
    if (msgid === SEND.SEND_LEVEL_OUT && session.inRoom === false) {
      if (session.leaveTask) await session.leaveTask;
      else sendLeaveResult(ws, session);
      return;
    }
    const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
    if (!table) {
      return;
    }
    if (session.inRoom === false) return;
    const game = gameOf(table.roomType);
    await game.afterRound?.(ctxOf(ws, session, table));
    if (table.kind === "normal" && lifecycle.isExpired(table) && table.phase !== "playing") {
      await expireRoom(table);
      return;
    }
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
    await game.afterRound?.(ctxOf(ws, session, table));
    if (table.kind === "normal" && lifecycle.isExpired(table) && table.phase !== "playing") {
      await expireRoom(table);
    }
    if (handled && game.kind === "normal") pool.expand();
    if (handled && (msgid === SEND.GGL_BUY || msgid === SEND.SEND_CARRY_SCORE || msgid === SEND.SEND_STANDUP)) {
      pushPoint(ws, session);
      await persist(session);
    }
  }

  function sendLeaveResult(ws, session) {
    send(ws, PUSH.USER_LEVEL_ROOM, { roomId: session.roomId, uid: session.userId, type: 1 });
  }

  function leaveTable(ws, session, table, game) {
    if (session.leaveTask) return session.leaveTask;
    const task = (async () => {
      await game.afterRound?.(ctxOf(ws, session, table));
      session.inRoom = false;
      const cash = game.onLeave(ctxOf(ws, session, table));
      if (runtime.wallet.credit) await runtime.wallet.credit(session, Number(cash || 0));
      else session.wallet += Number(cash || 0);
      pushPoint(ws, session);
      await persist(session);
      await game.afterRound?.(ctxOf(ws, session, table));
      // The original client returns to its hall only after receiving 2205
      // for its own uid/roomId. Spectators need the same receipt as players.
      sendLeaveResult(ws, session);
    })();
    // Keep the in-flight operation on the resident session across hot reloads.
    session.leaveTask = task;
    const clearTask = () => { if (session.leaveTask === task) delete session.leaveTask; };
    task.then(clearTask, clearTask);
    return task;
  }

  function tick() {
    const closing = [];
    for (const table of [...runtime.registry.tables.values()]) {
      const game = gameOf(table.roomType);
      const context = { runtime, io: tableIo(table), table };
      const admission = game?.afterRound?.(context);
      if (admission) {
        closing.push(admission);
        continue;
      }
      if (table.kind === "normal" && lifecycle.isExpired(table) && table.phase !== "playing") {
        closing.push(expireRoom(table));
        continue;
      }
      if (game) {
        game.tick(context);
        const settled = game.afterRound?.(context);
        if (settled) {
          closing.push(settled);
          continue;
        }
      }
      if (table.kind === "normal" && lifecycle.isExpired(table) && table.phase !== "playing") {
        closing.push(expireRoom(table));
      }
      if (table.kind !== "normal" && table.retired) runtime.registry.removeTable(table.roomId, table.agentId, table.gameId);
    }
    pool.expand();
    return Promise.allSettled(closing);
  }

  async function onClose(ws) {
    const session = runtime.registry.session(ws);
    if (!session) {
      runtime.registry.drop(ws);
      return;
    }
    const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
    const game = table ? gameOf(table.roomType) : null;
    if (table && game && session.inRoom !== false) {
      await leaveTable(ws, session, table, game);
    } else if (session.inRoom !== false) {
      await persist(session);
    }
    runtime.registry.drop(ws);
  }

  function getDevHoldemRecordDetail(roomId, inningNum) {
    if (runtime.env !== "dev") return null;
    const table = runtime.registry.listByRoomType(19).find((item) => Number(item.roomId) === Number(roomId));
    return table ? holdemEngine.texasHistoryDetail(table, inningNum) : null;
  }

  return { onMessage, tick, onClose, games, getDevHoldemRecordDetail,
    handleLocalRequest: (req, res) => localHttp?.handleLocalRequest(runtime, req, res) || false };
}
