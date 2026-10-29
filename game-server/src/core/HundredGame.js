import { rel } from '../rel.js';
const version = new URL(import.meta.url).searchParams.get('v') || '0';
const { SEND, PUSH } = await rel(import.meta.url, '../messages.js', version);
const { debit } = await rel(import.meta.url, '../wallet/index.js', version);
const { GameBase } = await rel(import.meta.url, './GameBase.js', version);
const robots = await rel(import.meta.url, './robot.js', version);

export class HundredGame extends GameBase {
  createTable(roomId, roomType, roomRow) {
    return {
      ...super.createTable(roomId, roomType, roomRow),
      people: 0,
      inning: 1,
      state: this.betState(),
      roomIndex: Number(roomRow?.room_index || 1),
      playerBets: new Map(),
      playerSessions: new Map(), visitors: new Set(),
      totalBetsByArea: this.createAreas(),
      tick: 0,
      ...this.extraTableFields(roomRow),
    };
  }

  extraTableFields(_roomRow) {
    return {};
  }

  createAreas() {
    return [];
  }

  betState() {
    return 2;
  }

  enter(table, session) {
    table.visitors ||= new Set();
    table.playerSessions ||= new Map();
    const uid = Number(session.userId);
    if (!table.visitors.has(uid)) { table.visitors.add(uid); table.people += 1; }
    table.playerSessions.set(uid, session);
  }

  betOptions(table) {
    return { minBet: Number(table.cfg?.hundred_min_bet ?? table.rules?.minBet ?? this.config.minBet ?? 100),
      maxBet: Number(table.cfg?.hundred_max_bet ?? table.rules?.maxBet ?? this.config.defaultMaxBet ?? 100000000),
      areas: Array.isArray(table.totalBetsByArea)
        ? table.totalBetsByArea.map(row => ({ areaId: row.areaId, odds: this.config.odds?.[row.areaId] || 1 }))
        : Object.keys(table.totalBetsByArea || {}).map(id => ({ areaId: Number(id), odds: table.rules?.betAreaOdds?.[id] || 1 })) };
  }

  tickRobots(ctx, now = Date.now(), rng = Math.random) {
    robots.tickHundredRoom(this, ctx, now, rng);
  }

  enterSnapshot(table, session) {
    return {
      roomType: table.roomType,
      state: table.state,
      roomId: table.roomId,
      inning: table.inning,
      points: session.wallet,
      myBets: table.playerBets.get(session.userId) || [],
      totalBetsByArea: table.totalBetsByArea,
    };
  }

  siblingRoomPayload(table) {
    return {
      roomId: table.roomId,
      roomIndex: table.roomIndex,
      roomType: table.roomType,
      totalPeople: table.people,
    };
  }

  ensureSiblingRooms(ctx) {
    const roomType = ctx.table.roomType;
    for (const cfg of ctx.runtime.configs.filter((row) => Number(row.room_type) === Number(roomType))) {
      const roomId = Number(cfg.game_room_config_id) * 10000 + Number(cfg.room_index || 0);
      if (!ctx.runtime.registry.getTable(roomId)) {
        ctx.runtime.registry.setTable(roomId, this.createTable(roomId, roomType, cfg));
      }
    }
  }

  placeBet(ctx, body) {
    const { table, session, send } = ctx;
    if (table.state !== this.betState()) {
      send(PUSH.BET_RESPONSE, {
        points: session.wallet,
        roomType: table.roomType,
        code: 1,
        myBets: table.playerBets.get(session.userId) || [],
        roomId: table.roomId,
      });
      return false;
    }
    const params = Array.isArray(body?.params) ? body.params : [];
    const options = this.betOptions(table);
    const normalized = params.map(item => ({ areaId: Number(item?.areaId), total: Number(item?.total) }));
    const total = normalized.reduce((sum, item) => sum + item.total, 0);
    if (!normalized.length || normalized.some(item => !options.areas.some(area => area.areaId === item.areaId)
      || !Number.isSafeInteger(item.total) || item.total < options.minBet || item.total > options.maxBet)
      || !Number.isSafeInteger(total) || !debit(session, total, ctx).ok) {
      send(PUSH.BET_RESPONSE, { points: session.wallet, roomType: table.roomType, code: 1,
        myBets: table.playerBets.get(session.userId) || [], roomId: table.roomId });
      return false;
    }
    const mine = table.playerBets.get(session.userId) || [];
    for (const item of normalized) {
      const areaId = Number(item.areaId);
      const total = Number(item.total || 0);
      const area = (table.totalBetsByArea || []).find((row) => row.areaId === areaId);
      if (area) {
        area.total += total;
      }
      const exist = mine.find((row) => row.areaId === areaId);
      if (exist) {
        exist.total += total;
      } else {
        mine.push({ areaId, total });
      }
    }
    table.playerBets.set(session.userId, mine);
    table.playerSessions ||= new Map();
    table.playerSessions.set(Number(session.userId), session);
    const broadcast = ctx.io?.broadcast ? ctx.io.broadcast.bind(ctx.io) : send;
    broadcast(PUSH.BET_BROADCAST, {
      roomId: table.roomId,
      roomType: table.roomType,
      allPlayerBets: table.totalBetsByArea,
    });
    send(PUSH.BET_RESPONSE, {
      points: session.wallet,
      roomType: table.roomType,
      code: 0,
      myBets: mine,
      myTotalBets: mine,
      betAreaIds: mine.map((item) => item.areaId),
      roomId: table.roomId,
    });
    return true;
  }

  onMessage(ctx, msgid, payload) {
    if (msgid === SEND.GR_GET_ALL_ROOMS_REQ) {
      this.ensureSiblingRooms(ctx);
      ctx.send(PUSH.GR_GET_ALL_ROOMS_RES, ctx.runtime.registry.listByRoomType(ctx.table.roomType).map((item) => this.siblingRoomPayload(item)));
      return true;
    }
    if (msgid === SEND.ENTER) {
      this.enter(ctx.table, ctx.session);
      ctx.send(PUSH.ENTER_RESPONSE, this.enterSnapshot(ctx.table, ctx.session));
      return true;
    }
    if (msgid === SEND.BET) {
      this.placeBet(ctx, payload || {});
      return true;
    }
    return false;
  }

  tick(ctx) {
    const table = ctx.table;
    table.tick = (table.tick || 0) + 1;
    const cycle = table.tick % (this.config.tickCycle || 8);
    this.onCycle(ctx, cycle);
    this.tickRobots(ctx);
    this.pushState(ctx);
  }

  onCycle(_ctx, _cycle) {}

  pushState(ctx) {
    ctx.io.broadcast(PUSH.GAME_STATE, {
      state: ctx.table.state,
      inning: ctx.table.inning,
      roomId: ctx.table.roomId,
      roomType: ctx.table.roomType,
    });
  }

  onLeave(ctx) {
    const uid = Number(ctx.session.userId);
    if (!ctx.table.visitors || ctx.table.visitors.delete(uid)) {
      ctx.table.people = Math.max(0, (ctx.table.people || 1) - 1);
    }
    if (!robots.hasPendingHundredBet(ctx.table, uid)) ctx.table.playerSessions?.delete(uid);
    return 0;
  }
}
