import { rel } from "./rel.js";

export async function createHandler(runtime) {
  const v = runtime.hotVersion;
  if (runtime.env === "dev") {
    const localConfigs = await rel(import.meta.url, "../../cache/rpc/room-configs.js", v);
    await localConfigs.refreshRoomConfigs(runtime);
  }
  const codec = await rel(import.meta.url, "./codec.js", v);
  const messages = await rel(import.meta.url, "./messages.js", v);
  const catalog = await rel(import.meta.url, "./games/catalog.js", v);
  const holdemEngine = await rel(import.meta.url, "./games/holdem/engine.js", v);
  const zjhEngine = await rel(import.meta.url, "./games/zjh/engine.js", v);
  const sgayEngine = await rel(import.meta.url, "./games/sgay/engine.js", v);
  const mahjongEngine = await rel(import.meta.url, "./games/mahjong/engine.js", v);
  const games = await catalog.loadGames(v);
  const fair = await rel(import.meta.url, "./core/fair-code.js", v);
  const lifecycle = await rel(import.meta.url, "./core/room-lifecycle.js", v);
  const poolModule = await rel(import.meta.url, "./core/room-pool.js", v);
  const features = await rel(import.meta.url, "./core/room-features.js", v);
  const seatView = await rel(import.meta.url, "./core/seat-view.js", v);
  const subscriptionsModule = await rel(import.meta.url, "./core/hundred-subscriptions.js", v);
  const subscriptions = subscriptionsModule.createHundredSubscriptions(runtime, gameOf, tableIo);
  const localHttp = runtime.env === "dev"
    ? await rel(import.meta.url, "../../cache/game-server/http.js", v)
    : null;
  const { SEND, PUSH } = messages;
  const pool = poolModule.createRoomPool(runtime, gameOf);
  for (const table of runtime.registry.tables.values()) {
    if (["zjh", "niuniu", "sss", "blackjack", "sgay", "mahjong"].includes(table.gameId)) {
      // Refresh only room policy; preserve the resident hand, seats and clocks.
      table.roomRules = gameOf(table.roomType).roomPolicy(table);
    }
    if (table.gameId === "holdem" && Number(table.roomType) === 19 && Number(table.cfg?.play_mode || 0) === 0) {
      // Adopt the corrected wire mode without replacing the live room/hand.
      table.playMode = 1;
    }
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
      const session = runtime.registry.session(ws);
      const table = session?.inRoom !== false && session
        ? runtime.registry.getTable(session.roomId, session.agentId, session.gameId) : null;
      if (table) payload = seatView.projectSeatMessage(table, session, msgid, payload);
      const hostHundredType = {19: 50, 25: 51, 24: 52, 31: 60, 26: 62}[Number(payload?.roomType)];
      if (msgid === PUSH.ROOM_TYPE_RESULT && hostHundredType
        && runtime.configs.some(row => Number(row.state ?? 1) === 1 && Number(row.room_type) === hostHundredType)) {
        payload = { ...payload, openHundredGame: Boolean(session?.openHundredGame),
          conf: { ...payload.conf, hundredSwitch: true } };
      }
      ws.send(codec.encodeFrame(msgid, payload));
    }
  }

  function tableIo(table) {
    const singleHundredPushes = new Set([PUSH.GAME_STATE, PUSH.DEAL_CARDS_AND_ODDS,
      PUSH.SHOWDOWN_POKERS, PUSH.PLAYER_NUM_CHANGE, PUSH.BET_BROADCAST,
      PUSH.PLAYER_BALANCE_UPDATE, PUSH.BET_RESPONSE, PUSH.SHUFFLING_POKERS,
      6233, 6234, 6235, 6236, 6237, 6238, 6240, 6241, 6242, 6243, 6244]);
    const selected = (session, msgid) => table.kind !== 'hundred' || !singleHundredPushes.has(msgid)
      || (Number(session.hundredRoomId ?? session.roomId) === Number(table.roomId)
        && String(session.hundredGameId ?? session.gameId) === String(table.gameId));
    const subscribed = (session) => table.kind === "hundred"
      ? session?.hundredRoomIds?.has(Number(table.roomId))
        || (!session?.hundredRoomIds && Number(session?.roomId) === Number(table.roomId))
      : Number(session?.roomId) === Number(table.roomId);
    const active = (session) => session && Number(session.agentId || 0) === Number(table.agentId || 0)
      && subscribed(session) && (table.kind === "hundred"
        ? session.authenticated !== false && (session.hundredInRoom === true || session.inRoom !== false)
        : session.inRoom !== false && String(session.gameId || table.gameId) === String(table.gameId));
    function deliver(ws, session, msgid, payload) {
      if ([PUSH.MB_SNC_ROOM_STATE, PUSH.MB_ROOM_BET_SETTLE].includes(msgid)) {
        const contexts = subscriptionsModule.hundredContexts(session, table);
        if (selected(session, PUSH.GAME_STATE) && !contexts.includes(2)) contexts.push(2);
        for (const customData of contexts) send(ws, msgid, { ...payload, customData });
      } else send(ws, msgid, payload);
    }
    return {
      env: runtime.env,
      wallet: runtime.wallet,
      send,
      prepareRoundSeats(roomInfo) {
        for (const [ws, session] of runtime.registry.sessions) {
          if (session.inRoom !== false && session.roomId === table.roomId
            && Number(session.agentId || 0) === Number(table.agentId || 0)
            && session.gameId === table.gameId && seatView.needsSeatViewRefresh(table, session)) {
            send(ws, PUSH.ROOM_INFO, roomInfo);
          }
        }
      },
      sessionFor(uid) {
        return [...runtime.registry.sessions.values()].find((session) => active(session)
          && Number(session.userId) === Number(uid));
      },
      broadcast(msgid, payload) {
        for (const ws of runtime.registry.sessions.keys()) {
          const session = runtime.registry.session(ws);
          if (active(session) && selected(session, msgid)) {
            deliver(ws, session, msgid, payload);
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
          if (active(session) && selected(session, msgid) && Number(session.userId) === Number(uid)) {
            deliver(ws, session, msgid, payload);
            if (msgid === PUSH.MB_ROOM_BET_SETTLE && !selected(session, PUSH.GAME_STATE)) {
              sendWalletPoint(ws, session);
            }
          }
        }
      },
      forEachPlayer(fn) {
        for (const [ws, session] of runtime.registry.sessions) {
          if (active(session)) {
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

  function sendWalletPoint(ws, session) {
    // common_model assigns this payload directly; native hundred views also accept a number.
    send(ws, PUSH.GAME_POINT_UPDATE, Number(session.wallet));
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

  function registeredHundredGame(session) {
    return runtime.registry.getTable(session.hundredRoomId, session.agentId, session.hundredGameId)?.kind === 'hundred';
  }

  function hundredTable(session, body = {}) {
    const roomType = Number(body.roomType || 50);
    const game = gameOf(roomType);
    if (!game || game.kind !== 'hundred') return null;
    const requestedId = Number(body.roomId);
    if (requestedId) {
      const existing = runtime.registry.getTable(requestedId, session.agentId, game.id);
      if (existing && Number(existing.roomType) === roomType) return existing;
    }
    const row = runtime.configs.find(row => Number(row.state ?? 1) === 1
      && Number(row.room_type) === roomType
      && (requestedId ? Number(row.game_room_config_id) * 10000 + Number(row.room_index || 0) === requestedId
        : Number(row.play_mode) === Number(body.playMode ?? ([53, 54, 55, 56, 57, 58, 59, 60].includes(roomType) ? 0 : 1))
          || (roomType === 62 && [0, 1].includes(Number(row.play_mode)) && [0, 1].includes(Number(body.playMode ?? 1)))));
    return row ? ensureTable(Number(row.game_room_config_id) * 10000 + Number(row.room_index || 0), roomType, session.agentId) : null;
  }

  function leaveHundred(ws, session) {
    const table = runtime.registry.getTable(session.hundredRoomId, session.agentId, session.hundredGameId);
    subscriptions.leave(session);
    if (table) gameOf(table.roomType).onMessage(ctxOf(ws, session, table), SEND.EXIT, { roomType: table.roomType });
    if (table && session.gameId === table.gameId) session.inRoom = false;
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
      if (body.action === "hundred-list") {
        const { listHundredLobbyRooms } = await rel(import.meta.url, './core/hundred-lobby.js', v);
        respond({ code: 200, data: listHundredLobbyRooms(runtime, gameOf, agentId, body) });
        return;
      }
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
      respond({ code: 503, error: error.code === 503 ? error.message : "房间暂不可用" });
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
        openHundredGame: Boolean(body.openHundredGame),
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
    // Inline shortcuts intentionally subscribe to OTHER games (60 -> 58, 62 -> 50).
    // Discovery and registration must follow the request, without changing the selected table.
    if (msgid === SEND.GR_GET_ALL_ROOMS_REQ && gameOf(payload?.roomType)?.kind === 'hundred') {
      const tables = subscriptions.rooms(session, payload);
      send(ws, PUSH.GR_GET_ALL_ROOMS_RES, tables.map(t => gameOf(t.roomType).siblingRoomPayload(t)));
      return;
    }
    if (msgid === SEND.MB_REG_ROOMS_REQ) {
      const body = payload || {};
      const tables = subscriptions.register(session, body), customData = Number(body.customData) || 0;
      send(ws, PUSH.MB_REG_ROOMS_RES, { mulRoomTypeList: tables.map(t => ({ roomType: t.roomType, roomId: t.roomId })), customData });
      send(ws, PUSH.MB_REGED_ROOM_INFOS, { roomInfos: tables.map(t => {
        const game = gameOf(t.roomType);
        return game.multiRoomSnapshot?.(t, session) ?? game.enterSnapshot(t, session);
      }), customData });
      return;
    }
    if (msgid === SEND.MB_UNREG_ROOMS_REQ) {
      const body = payload || {};
      subscriptions.unregister(session, body);
      send(ws, PUSH.MB_UNREG_ROOMS_RES, Object.keys(body).length
        ? { mulRoomTypeList: body.mulRoomTypeList || [], customData: Number(body.customData) || 0 } : {});
      return;
    }
    if (msgid === SEND.MB_ROOM_BET_REQ) {
      const body = payload || {}, table = subscriptions.target(session, body.roomId, body.roomType);
      if (!table) {
        send(ws, PUSH.MB_ROOM_BET_RES, { roomId: Number(body.roomId) || 0, roomType: Number(body.roomType) || 0,
          customData: Number(body.customData ?? 2), points: session.wallet, code: 95041 });
      } else {
        const request = { ...body, customData: body.customData ?? subscriptions.context(session, table) };
        await gameOf(table.roomType).placeBet(ctxOf(ws, session, table, request), request, PUSH.MB_ROOM_BET_RES);
        sendWalletPoint(ws, session);
      }
      return;
    }
    // The native Bairen overlay logs in independently, then sends 6105 without
    // 2102. Its room selection must not replace the normal Holdem roomId/gameId.
    const hundredRequest = [6107, 6111, 6129, 6130, 6131, 6132, 6133, 6134, 6135, SEND.ENTER, SEND.EXIT, SEND.BET, SEND.MB_REG_ROOMS_REQ,
      SEND.MB_UNREG_ROOMS_REQ, SEND.MB_ROOM_BET_REQ, SEND.GR_GET_ALL_ROOMS_REQ,
      SEND.REQUEST_100_RECORD, SEND.REQUEST_ONE_RECORD].includes(msgid);
    if (hundredRequest && (gameOf(payload?.roomType)?.kind === 'hundred'
      || (payload?.roomType == null && registeredHundredGame(session)))) {
      const entering = msgid === SEND.ENTER;
      const registered = runtime.registry.getTable(session.hundredRoomId, session.agentId, session.hundredGameId);
      const table = entering ? hundredTable(session, payload) : registered;
      if (table && payload?.roomType != null && Number(payload.roomType) !== Number(table.roomType)) return;
      if (table) {
        if (entering) {
          if (session.hundredInRoom && (session.hundredRoomId !== table.roomId || session.hundredGameId !== table.gameId)) {
            leaveHundred(ws, session);
          }
          subscriptions.select(session, table);
        }
        if (msgid === SEND.EXIT) { leaveHundred(ws, session); return; }
        const historyRequest = [SEND.REQUEST_100_RECORD, SEND.REQUEST_ONE_RECORD].includes(msgid);
        const targetId = historyRequest ? Number(payload?.roomId ?? payload?.gameRoomId ?? table.roomId)
          : msgid === SEND.MB_ROOM_BET_REQ ? Number(payload?.roomId) : table.roomId;
        if (historyRequest && (session.hundredInRoom !== true || !session.hundredRoomIds?.has(targetId))) {
          send(ws, PUSH.RETURN_100_RECORD, { gameRoomId: targetId || table.roomId, list: [] });
          return;
        }
        if ([SEND.BET, SEND.MB_ROOM_BET_REQ].includes(msgid)
          && (session.hundredInRoom !== true || !session.hundredRoomIds?.has(Number(targetId)))) return;
        const target = targetId === Number(table.roomId) ? table
          : session.hundredRoomIds?.has(targetId)
            ? runtime.registry.getTable(targetId, session.agentId, table.gameId) : null;
        if (target) await gameOf(target.roomType).onMessage(ctxOf(ws, session, target, payload || {}), msgid, payload || {});
        return;
      }
      if (entering) return;
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
      session.openHundredGame = Boolean(body.openHundredGame ?? session.openHundredGame);
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
    const request = seatView.restoreSeatRequest(table, session, msgid, payload || {});
    const messageTable = game.kind === "hundred" && msgid === SEND.MB_ROOM_BET_REQ && Number(request?.roomId)
      ? runtime.registry.getTable(Number(request.roomId), session.agentId, session.gameId) || table
      : table;
    const messageGame = gameOf(messageTable.roomType) || game;
    const messageContext = messageTable === table ? ctxOf(ws, session, table, request)
      : { ...ctxOf(ws, session, messageTable, request), table: messageTable };
    const handled = await messageGame.onMessage(messageContext, msgid, request);
    await messageGame.afterRound?.(messageContext);
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
      if (table.kind !== "hundred") leaveHundred(ws, session);
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
        const ticking = game.tick(context);
        if (ticking?.then) closing.push(ticking.catch(error => runtime.log.error('game tick failed', error.message)));
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
    leaveHundred(ws, session);
    const table = runtime.registry.getTable(session.roomId, session.agentId, session.gameId);
    const game = table ? gameOf(table.roomType) : null;
    if (table && game && session.inRoom !== false) {
      await leaveTable(ws, session, table, game);
    } else if (session.inRoom !== false) {
      await persist(session);
    }
    runtime.registry.drop(ws);
  }

  function getDevHoldemRecordDetail(roomId, inningNum, userId, agentId) {
    if (runtime.env !== "dev") return null;
    if (userId != null && agentId != null) {
      const table = runtime.registry.getTable(roomId, agentId, "zjh");
      if (table) return zjhEngine.historyDetail(table, inningNum, userId);
      const sgayTable = runtime.registry.getTable(roomId, agentId, "sgay");
      if (sgayTable) return sgayEngine.historyDetail(sgayTable, inningNum, userId);
      const mahjongTable = runtime.registry.getTable(roomId, agentId, "mahjong");
      if (mahjongTable) return mahjongEngine.historyDetail(mahjongTable, inningNum, userId);
    }
    const table = runtime.registry.listByRoomType(19).find((item) => Number(item.roomId) === Number(roomId));
    return table ? holdemEngine.texasHistoryDetail(table, inningNum) : null;
  }

  return { onMessage, tick, onClose, games, getDevHoldemRecordDetail,
    handleLocalRequest: (req, res) => localHttp?.handleLocalRequest(runtime, req, res) || false };
}
