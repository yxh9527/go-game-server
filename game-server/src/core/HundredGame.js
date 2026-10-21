import { SEND, PUSH } from "../messages.js";
import { debit } from "../wallet/index.js";
import { GameBase } from "./GameBase.js";

export class HundredGame extends GameBase {
  createTable(roomId, roomType, roomRow) {
    return {
      ...super.createTable(roomId, roomType, roomRow),
      people: 0,
      inning: 1,
      state: this.betState(),
      roomIndex: Number(roomRow?.room_index || 1),
      playerBets: new Map(),
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

  enter(table, _session) {
    table.people += 1;
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
    const mine = table.playerBets.get(session.userId) || [];
    for (const item of params) {
      const areaId = Number(item.areaId);
      const total = Number(item.total || 0);
      if (total <= 0 || !debit(session, total, ctx).ok) {
        continue;
      }
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
    send(PUSH.BET_BROADCAST, {
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
    ctx.table.people = Math.max(0, (ctx.table.people || 1) - 1);
    return 0;
  }
}
