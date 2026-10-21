import { PUSH, SEND } from "../messages.js";
import { debit } from "../wallet/index.js";
import { GameBase } from "./GameBase.js";
import { memberListSeats, publicObserver, publicSeat } from "./member.js";

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
    return publicSeat(member);
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
      memberList: memberListSeats(table.members, this.maxPeople()),
      OBmemberList: (table.observers || []).map((item) => publicObserver(item)),
      roomStart: this.seated(table).length >= this.minPeople(),
      memberNum: table.members.length,
      ...this.extraRoomInfo(table),
    };
  }

  buyIn(table, session) {
    return Math.max(Number(session.wallet) || 0, 0);
  }

  sit(table, session, host, opts = {}) {
    if (table.members.some((item) => item.uid === session.userId)) {
      return table.members.find((item) => item.uid === session.userId);
    }
    const buyIn = opts.buyIn !== undefined ? Math.max(Number(opts.buyIn) || 0, 0) : this.buyIn(table, session);
    if (buyIn > 0 && !debit(session, buyIn, host).ok) {
      return null;
    }
    const used = new Set(table.members.map((item) => item.pos));
    let pos = Number(opts.pos);
    if (!Number.isInteger(pos) || pos < 0 || pos >= this.maxPeople() || used.has(pos)) {
      pos = this.nextSeat(table);
    }
    const member = {
      uid: session.userId,
      name: session.name,
      point: buyIn,
      pos,
      state: 1,
      lastOperation: 0,
      totalBet: 0,
      streetBet: 0,
      dealer: false,
      clubId: session.clubId || 0,
    };
    table.members.push(member);
    table.observers = (table.observers || []).filter((item) => item.uid !== session.userId);
    if (buyIn > 0) {
      this.afterSit(table, member, session);
      this.queueStart(table);
    }
    return member;
  }

  watch(table, session) {
    if (table.members.some((item) => item.uid === session.userId)) {
      return;
    }
    if (!table.observers.some((item) => item.uid === session.userId)) {
      table.observers.push({
        uid: session.userId,
        name: session.name,
        point: Number(session.wallet) || 0,
      });
    }
  }

  carryPanel(table, session) {
    const wallet = Math.max(Number(session.wallet) || 0, 0);
    const carryMin = Number(table.carryMin) || this.buyIn(table, session) || 0;
    return {
      reason: 0,
      carryMin,
      carryMax: Math.max(wallet, carryMin),
      accountBalance: wallet,
      freezePoint: 0,
      carryInMultiple: 5,
      carryType: 0,
      isByServerSettle: false,
    };
  }

  onSitDown(ctx) {
    const { table, session, body, send } = ctx;
    const member = this.sit(table, session, ctx, {
      pos: body?.position ?? body?.pos,
      buyIn: 0,
    });
    if (!member) {
      return;
    }
    send(PUSH.JOIN_ROOM, this.publicMember(member));
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(table));
    send(PUSH.CARRYIN_RESULT, this.carryPanel(table, session));
  }

  onCarryIn(ctx) {
    const { table, session, send } = ctx;
    if (!table.members.some((item) => item.uid === session.userId)) {
      this.onSitDown(ctx);
      return;
    }
    send(PUSH.CARRYIN_RESULT, this.carryPanel(table, session));
  }

  onCarryScore(ctx) {
    const { table, session, body, send } = ctx;
    let member = table.members.find((item) => item.uid === session.userId);
    if (!member) {
      member = this.sit(table, session, ctx, { buyIn: 0, pos: body?.position ?? body?.pos });
      if (!member) {
        return;
      }
      send(PUSH.JOIN_ROOM, this.publicMember(member));
    }
    const amount = Math.max(Number(body?.carryIn) || 0, 0);
    const min = Number(table.carryMin) || 0;
    if (amount < min) {
      send(PUSH.CARRY_SCORE_RESULT, { uid: session.userId, state: 1, carryIn: amount });
      return;
    }
    if (!debit(session, amount, ctx).ok) {
      send(PUSH.CARRY_SCORE_RESULT, { uid: session.userId, state: 1, carryIn: amount });
      return;
    }
    const wasEmpty = member.point <= 0;
    member.point += amount;
    if (wasEmpty) {
      this.afterSit(table, member, session);
      this.queueStart(table);
    }
    ctx.io.broadcast(PUSH.CARRY_SCORE_RESULT, { uid: session.userId, state: 0, carryIn: amount });
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(table));
  }

  onStandUp(ctx) {
    const { table, session } = ctx;
    const member = table.members.find((item) => item.uid === session.userId);
    if (!member) {
      return;
    }
    this.abandonIfPlaying(ctx, member);
    session.wallet += member.point || 0;
    table.members = table.members.filter((item) => item.uid !== session.userId);
    this.watch(table, session);
    ctx.io.broadcast(PUSH.USER_STANDUP_ROOM, session.userId);
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(table));
  }

  afterSit(_table, _member, _session) {}

  queueStart(table) {
    const ready = this.seated(table);
    const hasHuman = ready.some((item) => !item.bot);
    if (table.phase === "idle" && hasHuman && ready.length >= this.minPeople()) {
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

  onMessage(ctx, msgid, payload) {
    ctx.body = payload || {};
    if (msgid === SEND.SEND_SITDOWN) {
      this.onSitDown(ctx);
      return true;
    }
    if (msgid === SEND.SEND_CARRYIN) {
      this.onCarryIn(ctx);
      return true;
    }
    if (msgid === SEND.SEND_CARRY_SCORE) {
      this.onCarryScore(ctx);
      return true;
    }
    if (msgid === SEND.SEND_STANDUP) {
      this.onStandUp(ctx);
      return true;
    }
    return false;
  }

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
