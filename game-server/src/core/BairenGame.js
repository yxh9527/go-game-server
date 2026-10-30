import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { HundredGame } = await rel(import.meta.url, './HundredGame.js', v);
const { SEND, PUSH } = await rel(import.meta.url, '../messages.js', v);
const { configuredHundredRooms } = await rel(import.meta.url, './hundred-subscriptions.js', v);

export class BairenGame extends HundredGame {
  constructor(config, engine, roomRules) { super(config); this.engine = engine; this.rulesForRoom = roomRules; }
  get roomType() { return this.roomTypes[0]; }

  addViewer(table, session) {
    const uid = Number(session.userId);
    if (!table.visitors.has(uid)) {
      table.visitors.add(uid);
      table.people += 1;
      return true;
    }
    return false;
  }

  removeViewer(table, session) {
    const uid = Number(session.userId);
    const removed = table.visitors.delete(uid);
    if (removed) table.people = Math.max(0, table.people - 1);
    // Preserve ownership of unsettled bets even after the viewer disconnects.
    if (!table.playerBets.has(uid) || table.hand?.settled) table.playerSessions.delete(uid);
    return removed;
  }

  extraTableFields(row) {
    const rules = this.rulesForRoom(row, this.config);
    return { rules, playMode: rules.playMode, state: this.engine.PHASE.IDLE, inning: 1,
      people: 0, visitors: new Set(), playerSessions: new Map(), playerBets: new Map(),
      totalBetsByArea: Object.fromEntries(Array.from({ length: Object.keys(rules.betAreaOdds).length }, (_, i) => [i + 1, 0])),
      ways: this.config.initialWays?.() || { 1: { max: 100, ways: [] }, 2: { max: 33, ways: [] },
        3: { max: 5, ways: [0, 0, 0, 0, 0] } },
      boardTypeStats: {}, typeHistory: [], systemInningScore: 0, systemTodayTotalScore: 0,
      cardColor: 0, phaseEndsAt: 0, hand: null };
  }

  buildConf(table) {
    return { roomType: this.roomType, gameRoomConfigId: table.rules.gameRoomConfigId,
      playMode: table.rules.playMode, hundredSwitch: false,
      hundredParams: { gameName: table.rules.gameName, gameRoomConfigId: table.rules.gameRoomConfigId,
        maxBet: table.rules.maxBet, betAreaOdds: this.engine.configuredOdds(table) } };
  }

  enterSnapshot(table, session) { return this.engine.roomSnapshot(table, session); }

  placeBet(ctx, body, responseId = PUSH.BET_RESPONSE) {
    return this.engine.acceptBet(ctx, body, responseId);
  }

  onJoin(ctx) {
    super.onJoin(ctx);
    if (ctx.session) {
      const added = this.addViewer(ctx.table, ctx.session);
      ctx.table.playerSessions.set(Number(ctx.session.userId), ctx.session);
      ctx.session.hundredRoomIds ||= new Set();
      ctx.session.hundredRoomIds.add(Number(ctx.table.roomId));
      if (added) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: this.roomType, roomId: ctx.table.roomId, playerNum: ctx.table.people });
    }
  }

  onLoginRoom(ctx) {
    ctx.table.playerSessions.set(Number(ctx.session.userId), ctx.session);
    ctx.send(PUSH.ENTER_RESPONSE, this.enterSnapshot(ctx.table, ctx.session));
  }

  configuredRooms(ctx) {
    const { runtime, table, session } = ctx;
    const list = configuredHundredRooms(runtime, this, session);
    if (!list.some(row => Number(row.roomId) === Number(table.roomId))) list.unshift(table);
    return list;
  }

  registerRooms(ctx, body = {}) {
    const { table, session } = ctx;
    const list = this.configuredRooms(ctx);
    const requested = body.mulRoomTypeList?.find(row => Number(row.roomType) === this.roomType)?.roomIds;
    const roomIds = new Set(Array.isArray(requested) ? requested.map(Number) : []);
    const rooms = list.filter(row => !roomIds.size || roomIds.has(Number(row.roomId)) || row === table);
    session.hundredRoomIds = new Set(rooms.map(row => Number(row.roomId)));
    for (const room of rooms) {
      if (this.addViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: this.roomType, roomId: room.roomId, playerNum: room.people });
      room.playerSessions.set(Number(session.userId), session);
    }
    ctx.send(PUSH.MB_REG_ROOMS_RES, { mulRoomTypeList: rooms.map(row => ({
      roomType: this.roomType, roomId: row.roomId })), customData: Number(body.customData) || 0 });
    ctx.send(PUSH.MB_REGED_ROOM_INFOS, { roomInfos: rooms.map(row => this.engine.roomSnapshot(row, session)),
      customData: Number(body.customData) || 0 });
  }

  onMessage(ctx, id, body = {}) {
    const { runtime, table, session } = ctx;
    if (id === SEND.GR_GET_ALL_ROOMS_REQ) {
      ctx.send(PUSH.GR_GET_ALL_ROOMS_RES, this.configuredRooms(ctx).map(room => this.siblingRoomPayload(room)));
      return true;
    }
    if (id === SEND.REQUEST_100_RECORD || id === SEND.REQUEST_ONE_RECORD) {
      if (id === SEND.REQUEST_ONE_RECORD) {
        const detail = this.engine.historyDetail(table, session.userId, Number(body.currInning));
        if (detail) { ctx.send(PUSH.RETURN_ONE_RECORD, detail); return true; }
      }
      // Missing/expired details refresh the authorized list instead of sending
      // a partial card object that the original renderer cannot consume.
      ctx.send(PUSH.RETURN_100_RECORD, this.engine.historyList(table, session.userId));
      return true;
    }
    if (id === SEND.ENTER) {
      const uid = Number(session.userId);
      const added = this.addViewer(table, session);
      session.hundredRoomIds ||= new Set();
      session.hundredRoomIds.add(Number(table.roomId));
      table.playerSessions.set(uid, session);
      ctx.send(PUSH.ENTER_RESPONSE, this.enterSnapshot(table, session));
      if (added) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: this.roomType, roomId: table.roomId, playerNum: table.people });
      return true;
    }
    if (id === SEND.MB_REG_ROOMS_REQ) {
      this.registerRooms(ctx, body);
      return true;
    }
    if (id === SEND.MB_UNREG_ROOMS_REQ) {
      const roomTypes = body.mulRoomTypeList?.map(row => Number(row.roomType)) || [];
      if (!roomTypes.length || roomTypes.includes(this.roomType)) {
        // Closing the multi-bet panel does not exit the selected single table.
        // The native Mahjong host sends an empty 6124 immediately after 6123.
        const selectedId = session.hundredInRoom === true && session.hundredGameId === this.id
          ? Number(session.hundredRoomId) : null;
        for (const roomId of session.hundredRoomIds || []) {
          if (Number(roomId) === selectedId) continue;
          const room = runtime.registry.getTable(roomId, session.agentId, this.id);
          if (room && this.removeViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
            roomType: this.roomType, roomId: room.roomId, playerNum: room.people });
        }
        session.hundredRoomIds?.clear();
        if (selectedId != null) session.hundredRoomIds?.add(selectedId);
      }
      ctx.send(PUSH.MB_UNREG_ROOMS_RES, { mulRoomTypeList: body.mulRoomTypeList || [],
        customData: Number(body.customData) || 0 });
      return true;
    }
    if (id === SEND.BET || id === SEND.MB_ROOM_BET_REQ) {
      const responseId = id === SEND.MB_ROOM_BET_REQ ? PUSH.MB_ROOM_BET_RES : PUSH.BET_RESPONSE;
      this.placeBet(ctx, body, responseId);
      return true;
    }
    if (id === SEND.EXIT) {
      const roomIds = new Set([Number(table.roomId), ...(session.hundredRoomIds || [])]);
      for (const roomId of roomIds) {
        const room = runtime.registry.getTable(roomId, session.agentId, this.id);
        if (room && this.removeViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
          roomType: this.roomType, roomId: room.roomId, playerNum: room.people });
      }
      session.hundredRoomIds?.clear();
      session.hundredInRoom = false;
      if (session.gameId === this.id) session.inRoom = false;
      return true;
    }
    if (super.onMessage(ctx, id, body)) return true;
    return false;
  }

  tick(ctx) {
    const table = ctx.table;
    // New rounds adopt current public game policy, while each hand keeps its
    // already accepted reserve factor and odds through settlement retries.
    table.config = this.config;
    this.engine.tick(ctx.io, table, Date.now(), { ...ctx, gameConfig: this.config });
    this.tickRobots(ctx);
  }

  pushState(ctx) {
    ctx.io.broadcast(PUSH.MB_SNC_ROOM_STATE, this.engine.roomSnapshot(ctx.table,
      { userId: 0, wallet: 0 }));
  }
}

