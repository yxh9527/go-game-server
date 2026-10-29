import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { HundredGame } = await rel(import.meta.url, '../../core/HundredGame.js', v);
const { SEND, PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const engine = await rel(import.meta.url, './engine.js', v);

export class HundredHoldemGame extends HundredGame {
  constructor() { super(config); }

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
    const rules = roomRules(row, this.config);
    return { rules, playMode: rules.playMode, state: engine.PHASE.IDLE, inning: 1,
      people: 0, visitors: new Set(), playerSessions: new Map(), playerBets: new Map(),
      totalBetsByArea: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [i + 1, 0])),
      ways: { 1: { max: 100, ways: [] }, 2: { max: 33, ways: [] },
        3: { max: 5, ways: [0, 0, 0, 0, 0] } },
      boardTypeStats: {}, typeHistory: [], systemInningScore: 0, systemTodayTotalScore: 0,
      cardColor: 0, phaseEndsAt: 0, hand: null };
  }

  buildConf(table) {
    return { roomType: 50, gameRoomConfigId: table.rules.gameRoomConfigId,
      playMode: table.rules.playMode, hundredSwitch: false,
      hundredParams: { gameName: table.rules.gameName, gameRoomConfigId: table.rules.gameRoomConfigId,
        maxBet: table.rules.maxBet, betAreaOdds: engine.configuredOdds(table) } };
  }

  enterSnapshot(table, session) { return engine.roomSnapshot(table, session); }

  onJoin(ctx) {
    super.onJoin(ctx);
    if (ctx.session) {
      const added = this.addViewer(ctx.table, ctx.session);
      ctx.table.playerSessions.set(Number(ctx.session.userId), ctx.session);
      ctx.session.hundredRoomIds ||= new Set();
      ctx.session.hundredRoomIds.add(Number(ctx.table.roomId));
      if (added) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: 50, roomId: ctx.table.roomId, playerNum: ctx.table.people });
    }
  }

  onLoginRoom(ctx) {
    ctx.table.playerSessions.set(Number(ctx.session.userId), ctx.session);
    ctx.send(PUSH.ENTER_RESPONSE, this.enterSnapshot(ctx.table, ctx.session));
  }

  registerRooms(ctx, body = {}) {
    const { runtime, table, session } = ctx;
    const configs = (runtime.configs || []).filter(row => Number(row.state ?? 1) === 1
      && Number(row.room_type) === 50);
    const list = [];
    configs.forEach((row, index) => {
      const roomIndex = Number(row.room_index) || 0;
      const roomId = Number(row.game_room_config_id) * 10000 + roomIndex;
      let sibling = runtime.registry.getTable(roomId, session.agentId, this.id);
      if (!sibling && roomId !== Number(table.roomId)) {
        sibling = this.createTable(roomId, 50, { ...row, room_index: roomIndex });
        sibling.agentId = Number(session.agentId) || 0;
        runtime.registry.setTable(roomId, sibling, session.agentId, this.id);
      }
      sibling ||= table;
      if (Number(sibling.roomId) === Number(table.roomId)) sibling = table;
      list.push(sibling);
    });
    if (!list.some(row => Number(row.roomId) === Number(table.roomId))) list.unshift(table);
    const requested = body.mulRoomTypeList?.find(row => Number(row.roomType) === 50)?.roomIds;
    const roomIds = new Set(Array.isArray(requested) ? requested.map(Number) : []);
    const rooms = list.filter(row => !roomIds.size || roomIds.has(Number(row.roomId)) || row === table);
    session.hundredRoomIds = new Set(rooms.map(row => Number(row.roomId)));
    for (const room of rooms) {
      if (this.addViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: 50, roomId: room.roomId, playerNum: room.people });
      room.playerSessions.set(Number(session.userId), session);
    }
    ctx.send(PUSH.MB_REG_ROOMS_RES, { mulRoomTypeList: rooms.map(row => ({
      roomType: 50, roomId: row.roomId })), customData: Number(body.customData) || 0 });
    ctx.send(PUSH.MB_REGED_ROOM_INFOS, { roomInfos: rooms.map(row => engine.roomSnapshot(row, session)),
      customData: Number(body.customData) || 0 });
  }

  onMessage(ctx, id, body = {}) {
    const { runtime, table, session } = ctx;
    if (id === SEND.ENTER) {
      const uid = Number(session.userId);
      const added = this.addViewer(table, session);
      session.hundredRoomIds ||= new Set();
      session.hundredRoomIds.add(Number(table.roomId));
      table.playerSessions.set(uid, session);
      ctx.send(PUSH.ENTER_RESPONSE, this.enterSnapshot(table, session));
      if (added) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
        roomType: 50, roomId: table.roomId, playerNum: table.people });
      return true;
    }
    if (id === SEND.MB_REG_ROOMS_REQ) {
      this.registerRooms(ctx, body);
      return true;
    }
    if (id === SEND.MB_UNREG_ROOMS_REQ) {
      const roomTypes = body.mulRoomTypeList?.map(row => Number(row.roomType)) || [];
      if (!roomTypes.length || roomTypes.includes(50)) {
        for (const roomId of session.hundredRoomIds || []) {
          const room = runtime.registry.getTable(roomId, session.agentId, this.id);
          if (room && this.removeViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
            roomType: 50, roomId: room.roomId, playerNum: room.people });
        }
        session.hundredRoomIds?.clear();
      }
      ctx.send(PUSH.MB_UNREG_ROOMS_RES, { mulRoomTypeList: body.mulRoomTypeList || [],
        customData: Number(body.customData) || 0 });
      return true;
    }
    if (id === SEND.BET || id === SEND.MB_ROOM_BET_REQ) {
      const responseId = id === SEND.MB_ROOM_BET_REQ ? PUSH.MB_ROOM_BET_RES : PUSH.BET_RESPONSE;
      engine.acceptBet(ctx, body, responseId);
      return true;
    }
    if (id === SEND.EXIT) {
      const roomIds = new Set([Number(table.roomId), ...(session.hundredRoomIds || [])]);
      for (const roomId of roomIds) {
        const room = runtime.registry.getTable(roomId, session.agentId, this.id);
        if (room && this.removeViewer(room, session)) ctx.io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
          roomType: 50, roomId: room.roomId, playerNum: room.people });
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
    engine.tick(ctx.io, table, Date.now(), ctx);
  }

  pushState(ctx) {
    ctx.io.broadcast(PUSH.MB_SNC_ROOM_STATE, engine.roomSnapshot(ctx.table,
      { userId: 0, wallet: 0 }));
  }
}

export default new HundredHoldemGame();
