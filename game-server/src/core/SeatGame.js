import { PUSH } from "../messages.js";
import { debit } from "../wallet/index.js";
import { GameBase } from "./GameBase.js";

export class SeatGame extends GameBase {
  createTable(roomId, roomType, roomRow) {
    return {
      ...super.createTable(roomId, roomType, roomRow),
      members: [],
      observers: [],
      currentInning: 0,
      roomState: 0,
      phase: "idle",
      startAt: 0,
      hand: null,
      dealerPos: 0,
      ...this.extraTableFields(roomRow),
    };
  }

  extraTableFields(_roomRow) {
    return {};
  }

  maxPeople() {
    return this.config.maxPeople || 9;
  }

  minPeople() {
    return this.config.minPeople || 2;
  }

  nextSeat(table) {
    const used = new Set(table.members.map((item) => item.pos));
    let pos = 0;
    while (used.has(pos) && pos < this.maxPeople()) {
      pos += 1;
    }
    return pos;
  }

  seated(table) {
    return table.members.filter((item) => item.point > 0);
  }

  publicMember(member) {
    return {
      uid: member.uid,
      name: member.name,
      pos: member.pos,
      point: member.point,
      state: member.folded ? 3 : member.state,
      lastOperation: member.lastOperation || 0,
      xiaZhuData: member.totalBet || 0,
      banker: Boolean(member.dealer),
    };
  }

  extraRoomInfo(_table) {
    return {};
  }

  roomInfo(table) {
    return {
      roomId: table.roomId,
      roomType: table.roomType,
      currentInning: table.currentInning,
      maxPeople: this.maxPeople(),
      roomState: table.phase === "playing" ? 2 : 1,
      memberList: table.members.map((item) => this.publicMember(item)),
      OBmemberList: table.observers,
      roomStart: this.seated(table).length >= this.minPeople(),
      memberNum: table.members.length,
      ...this.extraRoomInfo(table),
    };
  }

  buyIn(table, session) {
    return Math.max(Number(session.wallet) || 0, 0);
  }

  sit(table, session, host) {
    if (table.members.some((item) => item.uid === session.userId)) {
      return null;
    }
    const buyIn = this.buyIn(table, session);
    if (!debit(session, buyIn, host).ok) {
      return null;
    }
    const member = {
      uid: session.userId,
      name: session.name,
      point: buyIn,
      pos: this.nextSeat(table),
      state: 1,
      lastOperation: 0,
      totalBet: 0,
      dealer: false,
    };
    table.members.push(member);
    this.afterSit(table, member, session);
    this.queueStart(table);
    return member;
  }

  watch(table, session) {
    if (!table.observers.some((item) => item.uid === session.userId)) {
      table.observers.push({ uid: session.userId, name: session.name, point: session.wallet });
    }
  }

  afterSit(_table, _member, _session) {}

  queueStart(table) {
    if (table.phase === "idle" && this.seated(table).length >= this.minPeople()) {
      table.phase = "starting";
      table.startAt = Date.now() + (this.config.startDelayMs || 3000);
    }
  }

  onJoin(ctx) {
    const { table, session, body, send } = ctx;
    if (body?.isOb) {
      this.watch(table, session);
    } else {
      const member = this.sit(table, session, ctx);
      if (member) {
        send(PUSH.JOIN_ROOM, this.publicMember(member));
      }
    }
    super.onJoin(ctx);
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(table));
  }

  onLoginRoom(ctx) {
    ctx.send(PUSH.ROOM_INFO, this.roomInfo(ctx.table));
    this.onPlayingSnapshot(ctx);
  }

  onPlayingSnapshot(_ctx) {}

  tick(ctx) {
    const table = ctx.table;
    const now = Date.now();
    if (table.phase === "starting" && now >= table.startAt) {
      this.startRound(ctx);
      return;
    }
    if (table.phase === "playing") {
      this.playTick(ctx, now);
    }
  }

  startRound(_ctx) {}

  playTick(_ctx, _now) {}

  abandonIfPlaying(_ctx, _member) {}

  onLeave(ctx) {
    const table = ctx.table;
    const uid = ctx.session.userId;
    const member = table.members.find((item) => item.uid === uid);
    if (!member) {
      table.observers = (table.observers || []).filter((item) => item.uid !== uid);
      return 0;
    }
    this.abandonIfPlaying(ctx, member);
    const cash = member.point || 0;
    table.members = table.members.filter((item) => item.uid !== uid);
    table.observers = (table.observers || []).filter((item) => item.uid !== uid);
    if (!table.members.some((item) => !item.bot)) {
      table.members = table.members.filter((item) => !item.bot);
      table.phase = "idle";
      table.hand = null;
    }
    ctx.io.broadcast(PUSH.USER_STANDUP_ROOM, uid);
    ctx.io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(table));
    return cash;
  }
}
