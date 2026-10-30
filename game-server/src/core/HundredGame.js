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
      roomIndex: Number(roomRow?.room_index ?? 1),
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
    const odds = table.rules?.betAreaOdds || this.config.odds || {};
    const ids = Array.isArray(table.totalBetsByArea)
      ? table.totalBetsByArea.map(row => row.areaId)
      : Object.keys(table.totalBetsByArea || {}).map(Number);
    const areas = ids.map(areaId => ({ areaId, odds: Number(odds[areaId] ?? 1) }))
      .filter(area => !this.config.rejectZeroOdds || (Number.isFinite(area.odds) && area.odds > 0));
    return { minBet: Number(table.cfg?.hundred_min_bet ?? table.rules?.minBet ?? this.config.minBet ?? 100),
      maxBet: Number(table.cfg?.hundred_max_bet ?? table.rules?.maxBet ?? this.config.defaultMaxBet ?? 100000000),
      areas };
  }

  tickRobots(ctx, now = Date.now(), rng = Math.random) {
    if (this.robotsEnabled?.(ctx.table) === false) return;
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

  placeBet(ctx, body, responseId = PUSH.BET_RESPONSE) {
    const { table, session, send } = ctx;
    const customData = Number(body?.customData ?? 2);
    if (table.state !== this.betState() || table.phaseEndsAt && Date.now() >= table.phaseEndsAt) {
      send(responseId, { customData,
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
    const cumulative = new Map((table.playerBets.get(session.userId) || []).map(bet => [bet.areaId, bet.total]));
    for (const bet of normalized) cumulative.set(bet.areaId, (cumulative.get(bet.areaId) || 0) + bet.total);
    const total = normalized.reduce((sum, item) => sum + item.total, 0);
    if (!normalized.length || normalized.some(item => !options.areas.some(area => area.areaId === item.areaId)
      || !Number.isSafeInteger(item.total) || item.total < options.minBet || item.total > options.maxBet)
      || [...cumulative.values()].some(amount => !Number.isSafeInteger(amount) || amount > options.maxBet)
      || body.roomId != null && Number(body.roomId) !== Number(table.roomId)
      || body.roomType != null && Number(body.roomType) !== Number(table.roomType)
      || !Number.isSafeInteger(total) || !debit(session, total, ctx).ok) {
      send(responseId, { customData, points: session.wallet, roomType: table.roomType, code: 1,
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
    send(responseId, { customData,
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

  phasesFor(_table) { return this.config.timedPhases; }

  tick(ctx) {
    this.beforeTick?.(ctx);
    const table = ctx.table;
    const phases = this.phasesFor(table);
    if (phases?.length) {
      const now = Date.now();
      if (table.hundredCycleTask) return table.hundredCycleTask;
      if (table.hundredPhaseIndex == null) {
        table.hundredPhaseIndex = Math.max(0, phases.findIndex(p => p.state === table.state));
        table.phaseEndsAt = now + phases[table.hundredPhaseIndex].seconds * 1000;
        this.pushState(ctx);
      } else if (now >= table.phaseEndsAt) {
        let index = (table.hundredPhaseIndex + 1) % phases.length;
        for (let skipped = 0; phases[index].skip && skipped < phases.length; skipped++) index = (index + 1) % phases.length;
        const phase = phases[index];
        table.phaseEndsAt = now + phase.seconds * 1000;
        const done = () => {
          table.hundredPhaseIndex = index;
          table.phaseEndsAt = Date.now() + phase.seconds * 1000;
          this.pushState(ctx); this.tickRobots(ctx);
        };
        const result = this.onCycle(ctx, phase.cycle);
        if (result?.then) {
          const task = result.then(done).catch(error => { table.phaseEndsAt = Date.now(); throw error; })
            .finally(() => { table.hundredCycleTask = null; });
          table.hundredCycleTask = task; return task;
        }
        done(); return;
      }
      this.tickRobots(ctx); return;
    }
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
