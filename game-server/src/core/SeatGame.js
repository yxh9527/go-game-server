import { credit, debit, walletOf } from "../wallet/index.js";
import { GameBase } from "./GameBase.js";
import { rel } from "../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { memberListSeats, publicSeat, carryLeftTime } = await rel(import.meta.url, "./member.js", version);
const { PUSH, SEND } = await rel(import.meta.url, "../messages.js", version);
const features = await rel(import.meta.url, "./room-features.js", version);
const lifecycle = await rel(import.meta.url, "./room-lifecycle.js", version);
const robot = await rel(import.meta.url, "./robot.js", version);
const INITIAL_CARRY_TIMEOUT_MS = 12_000;

export class SeatGame extends GameBase {
  createTable(roomId, roomType, roomRow) {
    const table = lifecycle.initializeLifetime({
      ...super.createTable(roomId, roomType, roomRow),
      createdAt: Date.now(),
      members: [],
      observers: [],
      currentInning: 0,
      roomState: 0,
      phase: "idle",
      startAt: 0,
      hand: null,
      dealerPos: 0,
      carryMin: Math.max(0, Number(roomRow?.carry_min ?? this.config.defaultCarryMin) || 0),
      ...this.extraTableFields(roomRow),
    });
    features.initializeRoomStats(table);
    lifecycle.syncActivity(table);
    return table;
  }

  extraTableFields(_roomRow) {
    return {};
  }

  roomPolicy(table) {
    return table?.roomRules || {};
  }

  maxPeople(table) {
    return this.roomPolicy(table).maxPeople || this.config.maxPeople || 9;
  }

  minPeople(table) {
    return this.roomPolicy(table).gameStartNum || this.config.minPeople || 2;
  }

  shouldStandAfterRound(table, member) {
    return member.point <= 0 || member.point < Math.max(0, Number(table.carryMin) || 0);
  }

  nextSeat(table) {
    const used = new Set(table.members.map((item) => item.pos));
    let pos = 0;
    while (used.has(pos) && pos < this.maxPeople(table)) {
      pos += 1;
    }
    return pos;
  }

  seated(table) {
    return table.members.filter((item) => item.point > 0 && !item.pendingDeparture);
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
      gameTime: lifecycle.ROOM_LIFETIME_SECONDS,
      leftTime: lifecycle.remainingSeconds(table),
      maxPeople: this.maxPeople(table),
      roomState: table.phase === "playing" ? 2 : 1,
      memberList: memberListSeats(table.members, this.maxPeople(table)),
      OBmemberList: features.observerList(table),
      roomStart: this.seated(table).length >= this.minPeople(table),
      memberNum: table.members.length,
      ...this.extraRoomInfo(table),
    };
  }

  defaultBuyIn(table) {
    return Math.max(1, Number(table.carryMin) || 0);
  }

  buyIn(table, session) {
    return Math.min(Math.max(Number(session.wallet) || 0, 0), this.defaultBuyIn(table));
  }

  sit(table, session, host, opts = {}) {
    if (lifecycle.isExpired(table)) return null;
    if (table.members.some((item) => item.uid === session.userId)) {
      return table.members.find((item) => item.uid === session.userId);
    }
    const buyIn = opts.buyIn !== undefined ? Math.max(Number(opts.buyIn) || 0, 0) : this.buyIn(table, session);
    const used = new Set(table.members.map((item) => item.pos));
    let pos = Number(opts.pos);
    if (this.roomPolicy(table).randomSit) {
      const free = Array.from({ length: this.maxPeople(table) }, (_, i) => i).filter((i) => !used.has(i));
      pos = free[Math.floor(Math.random() * free.length)];
    }
    if (!Number.isInteger(pos) || pos < 0 || pos >= this.maxPeople(table) || used.has(pos)) {
      pos = this.nextSeat(table);
    }
    if (pos >= this.maxPeople(table)) return null;
    if (buyIn > 0 && !debit(session, buyIn, host).ok) return null;
    const member = {
      uid: session.userId,
      name: session.name,
      icon: session.icon,
      point: buyIn,
      pos,
      state: 1,
      lastOperation: 0,
      totalBet: 0,
      streetBet: 0,
      dealer: false,
      clubId: session.clubId || 0,
      bot: session.bot === true,
      // Stored on the resident seat: reopening the panel or hot-loading a new
      // game instance must not restart the initial buy-in window.
      carryDeadline: buyIn > 0 ? 0 : Date.now() + INITIAL_CARRY_TIMEOUT_MS,
    };
    table.members.push(member);
    features.recordCarryIn(table, member, buyIn);
    table.observers = (table.observers || []).filter((item) => item.uid !== session.userId);
    lifecycle.syncActivity(table);
    if (buyIn > 0) {
      this.afterSit(table, member, session);
      this.queueStart(table);
    }
    return member;
  }

  watch(table, session) {
    if (table.members.some((item) => item.uid === session.userId)) {
      lifecycle.syncActivity(table);
      return;
    }
    if (!table.observers.some((item) => item.uid === session.userId)) {
      table.observers.push({
        uid: session.userId,
        name: session.name,
        icon: session.icon,
        bot: session.bot === true,
        point: Number(session.wallet) || 0,
      });
    }
    lifecycle.syncActivity(table);
  }

  carryPanel(table, session) {
    const member = table.members.find((item) => item.uid === session.userId);
    const leftTime = member ? carryLeftTime(member) : 0;
    const wallet = Math.max(Number(session.wallet) || 0, 0);
    const carryMin = Number(table.carryMin) || this.buyIn(table, session) || 0;
    const carryMax = Math.max(wallet, carryMin);
    return {
      reason: 0,
      carryMin,
      // These fields are all consumed by the 2.0.1279 carry-in panel. Keep
      // them numeric even when a room does not configure an upper bound.
      carryDefault: carryMin,
      carryMax,
      configCarryMax: carryMax,
      carryBalance: Number(member?.point) || 0,
      accountBalance: wallet,
      leftTime,
      freezePoint: 0,
      carryInMultiple: 5,
      carryType: 0,
      carryCustom: carryMin,
      isByServerSettle: leftTime > 0,
    };
  }

  onSitDown(ctx) {
    const { table, session, body, send } = ctx;
    if (this.expirePendingCarry(ctx).has(session.userId)) return;
    const member = this.sit(table, session, ctx, {
      pos: body?.position ?? body?.pos,
      buyIn: 0,
    });
    if (!member) {
      return;
    }
    if (this.config.incrementalSeatUpdates) ctx.io.broadcast(PUSH.JOIN_ROOM, this.publicMember(member));
    else send(PUSH.JOIN_ROOM, this.publicMember(member));
    this.pushRoomSnapshot(ctx);
    send(PUSH.CARRYIN_RESULT, this.carryPanel(table, session));
    features.pushObservers(ctx);
  }

  onCarryIn(ctx) {
    const { table, session, send } = ctx;
    if (this.expirePendingCarry(ctx).has(session.userId)) return;
    if (!table.members.some((item) => item.uid === session.userId)) {
      // A stale panel/reconnect request cannot reserve another chair after
      // timeout. Only a fresh explicit SEND_SITDOWN starts a new attempt.
      send(PUSH.USER_STANDUP_ROOM, session.userId);
      return;
    }
    send(PUSH.CARRYIN_RESULT, this.carryPanel(table, session));
  }

  onCarryScore(ctx) {
    const { table, session, body, send } = ctx;
    if (lifecycle.isExpired(table)) return;
    this.expirePendingCarry(ctx);
    const member = table.members.find((item) => item.uid === session.userId);
    if (!member) {
      send(PUSH.CARRY_SCORE_RESULT, { uid: session.userId, state: 1, carryIn: 0, carryBalance: 0 });
      send(PUSH.USER_STANDUP_ROOM, session.userId);
      return;
    }
    // The online client sends carryIn in display units (score / 100). Room
    // configuration, wallet balances and member points are stored in score units.
    const requestedCarryIn = Number(body?.carryIn);
    const score = Number.isFinite(requestedCarryIn) && requestedCarryIn > 0
      ? Math.round(requestedCarryIn * 100)
      : 0;
    const amount = Number.isSafeInteger(score) ? score : 0;
    const min = Number(table.carryMin) || 0;
    if (amount <= 0 || amount < min) {
      send(PUSH.CARRY_SCORE_RESULT, {
        uid: session.userId,
        state: 1,
        carryIn: amount,
        carryBalance: Number(member.point) || 0,
      });
      return;
    }
    if (!debit(session, amount, ctx).ok) {
      send(PUSH.CARRY_SCORE_RESULT, {
        uid: session.userId,
        state: 1,
        carryIn: amount,
        carryBalance: Number(member.point) || 0,
      });
      return;
    }
    const wasEmpty = member.point <= 0;
    member.point += amount;
    delete member.carryDeadline;
    member.carryLeftTime = 0;
    features.recordCarryIn(table, member, amount);
    if (wasEmpty) {
      this.afterSit(table, member, session);
      this.queueStart(table);
    }
    ctx.io.broadcast(PUSH.CARRY_SCORE_RESULT, {
      uid: session.userId,
      state: 0,
      carryIn: amount,
      carryBalance: Number(member.point) || 0,
    });
    this.pushRoomSnapshot(ctx);
    features.pushObservers(ctx);
  }

  onStandUp(ctx) {
    const { table, session } = ctx;
    const member = table.members.find((item) => item.uid === session.userId);
    if (!member) {
      return;
    }
    if (this.holdSeatUntilRoundEnd(table, member)) {
      member.standAfterRound = true;
      ctx.send(PUSH.NEXT_ROUND_STANDUP_RES, true);
      return;
    }
    if (!(member.carryDeadline > 0 && member.point === 0)) {
      this.abandonIfPlaying(ctx, member);
      features.recordCarryOut(table, member, member.point);
      credit(session, member.point || 0, ctx);
    }
    table.members = table.members.filter((item) => item.uid !== session.userId);
    this.watch(table, session);
    ctx.io.broadcast(PUSH.USER_STANDUP_ROOM, session.userId);
    this.pushRoomSnapshot(ctx);
    features.pushObservers(ctx);
  }

  afterSit(_table, _member, _session) {}

  holdSeatUntilRoundEnd(_table, _member) { return false; }

  onCarryOut(ctx) {
    const { table, session, body } = ctx;
    const member = table.members.find(p => p.uid === session.userId);
    const amount = body.carryOutAmount;
    if (table.hand || table.partialCarryOut || !member || member.carryDeadline
        || !Number.isSafeInteger(amount) || amount <= 0 || amount > member.point - table.carryMin) {
      ctx.send(PUSH.CARRY_OUT_RES, { status: 0, point: member?.point || 0 });
      return true;
    }
    member.point -= amount;
    table.partialCarryOut = { member, session, amount, credited: false, persisted: false };
    return this.flushPartialCarryOut(ctx).then(() => true);
  }

  flushPartialCarryOut(ctx) {
    const { table, io } = ctx;
    if (table.partialCarryOutTask) return table.partialCarryOutTask;
    const payout = table.partialCarryOut;
    if (!payout) return;
    const task = (async () => {
      if (!payout.credited) {
        const result = await credit(payout.session, payout.amount, ctx);
        if (result?.ok === false) throw new Error('Partial cash-out rejected');
        payout.credited = true;
        features.recordCarryOut(table, payout.member, payout.amount);
      }
      if (!payout.persisted) {
        await walletOf(ctx).persist(payout.session);
        payout.persisted = true;
      }
      delete table.partialCarryOut;
      io.sendUser?.(payout.member.uid, PUSH.CARRY_OUT_RES, { status: 1, point: payout.member.point });
      io.sendUser?.(payout.member.uid, PUSH.GAME_POINT_UPDATE, { uid: payout.member.uid, point: payout.session.wallet });
      this.pushRoomSnapshot(ctx);
    })();
    table.partialCarryOutTask = task;
    task.catch(error => ctx.runtime?.log?.error('partial cash-out failed; will retry', error.message))
      .finally(() => { if (table.partialCarryOutTask === task) delete table.partialCarryOutTask; });
    return task;
  }

  afterRound(ctx) {
    const { table, io } = ctx;
    if (table.partialCarryOut) return this.flushPartialCarryOut(ctx);
    if (table.admissionTask) return table.admissionTask;
    if (table.phase === "playing" || table.hand) return;
    // Tournament chips/elimination belong to match, not cash-table buy-ins.
    if (Number(table.roomType) === 101) return;
    lifecycle.syncActivity(table);
    const inning = table.roomFeatures?.settledInning || 0;
    if (!table.roundAdmission) {
      if (!inning || inning <= (table.admissionCheckedInning || 0) || lifecycle.isExpired(table)) return;
      const now = Date.now();
      const players = table.members.filter((member) =>
        !(member.carryDeadline > now && member.point === 0)
        && (member.standAfterRound || member.pendingDeparture || this.shouldStandAfterRound(table, member)));
      if (!players.length) {
        table.admissionCheckedInning = inning;
        return;
      }
      // Capture balances after payouts. The ledger survives hot reload and
      // failed persistence, so a retry never pays the same chips twice.
      table.roundAdmission = { inning, payouts: players.map((member) => ({
        member, amount: member.point, credited: false, persisted: false, removed: false,
      })) };
    }
    const check = table.roundAdmission;
    const wallet = walletOf(ctx);
    const task = (async () => {
      for (const payout of check.payouts) {
        if (payout.removed) continue;
        const { member, amount } = payout;
        if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid post-hand seat balance");
        if (!payout.session) {
          payout.session = member.departureSession || (member.bot ? table.robotTraffic?.profiles.get(member.uid)?.session : null)
            || io.sessionFor?.(member.uid)
            || (ctx.session?.userId === member.uid ? ctx.session : null);
          if (!payout.session) {
            payout.session = { userId: member.uid, agentId: table.agentId,
              name: member.name, icon: member.icon, wallet: 0 };
            if (!member.bot) {
              try { await wallet.load(payout.session); }
              catch (error) { delete payout.session; throw error; }
            }
          }
        }
        if (!payout.credited) {
          if (member.bot) payout.session.wallet += amount;
          else if (amount > 0) {
            const result = await credit(payout.session, amount, ctx);
            if (result?.ok === false) throw new Error("Post-hand cash-out rejected");
          }
          payout.credited = true;
          features.recordCarryOut(table, member, amount);
          member.point = 0;
        }
        if (!payout.persisted) {
          if (!member.bot) await wallet.persist(payout.session);
          payout.persisted = true;
        }
        table.members = table.members.filter((item) => item !== member);
        if (!member.pendingDeparture) {
          this.watch(table, member.bot ? { ...payout.session, bot: true } : payout.session);
          if (member.bot) table.observers.find((item) => item.uid === member.uid).bot = true;
        }
        payout.removed = true;
        io.broadcast(PUSH.USER_STANDUP_ROOM, member.uid);
        if (!member.bot) io.sendUser?.(member.uid, PUSH.GAME_POINT_UPDATE, {
          uid: member.uid, point: payout.session.wallet,
        });
      }
      table.admissionCheckedInning = check.inning;
      delete table.roundAdmission;
      if (this.seated(table).length < this.minPeople(table)) table.phase = "idle";
      // ROOM_INFO resets original-client settlement animations. The existing
      // stand-up message is queued by the client until its settlement ends.
      features.pushObservers(ctx);
    })();
    table.admissionTask = task;
    task.catch((error) => ctx.runtime?.log?.error("post-hand cash-out failed; will retry", error.message))
      .finally(() => { if (table.admissionTask === task) delete table.admissionTask; });
    return task;
  }

  expirePendingCarry(ctx, now = Date.now()) {
    const { table, io } = ctx;
    const expired = table.members.filter((member) => !member.bot
      && member.carryDeadline > 0 && now >= member.carryDeadline && member.point === 0);
    if (!expired.length) return new Set();
    const ids = new Set(expired.map((member) => member.uid));
    const sessions = new Map();
    io.forEachPlayer?.((session) => sessions.set(session.userId, session));
    if (ctx.session) sessions.set(ctx.session.userId, ctx.session);
    table.members = table.members.filter((member) => !ids.has(member.uid));
    for (const member of expired) {
      // An unfunded chair has never joined a hand: no fold, settlement or
      // wallet operation is needed. Keep the player in this room as observer.
      this.watch(table, sessions.get(member.uid) || {
        userId: member.uid, name: member.name, icon: member.icon, wallet: 0,
      });
      io.broadcast(PUSH.USER_STANDUP_ROOM, member.uid);
    }
    this.pushRoomSnapshot(ctx);
    features.pushObservers(ctx);
    return ids;
  }

  queueStart(table) {
    if (table.standby || table.admissionTask || table.roundAdmission || table.partialCarryOut || lifecycle.isExpired(table)) return;
    if (!lifecycle.syncActivity(table)) return;
    const ready = this.seated(table);
    const hasHuman = ready.some((item) => !item.bot);
    if (table.phase === "idle" && (Number(table.roomType) !== 101 || hasHuman) && ready.length >= this.minPeople(table)) {
      table.phase = "starting";
      table.startAt = Math.max(table.startAt, Date.now() + (this.config.startDelayMs || 3000));
    }
  }

  onJoin(ctx) {
    const { table, session } = ctx;
    // Entering a seat game is always spectating. The player must explicitly
    // request a seat and complete the carry-in flow before joining a hand.
    this.watch(table, session);
    super.onJoin(ctx);
    this.pushRoomSnapshot(ctx);
    features.pushObservers(ctx);
  }

  onLoginRoom(ctx) {
    lifecycle.syncActivity(ctx.table);
    this.expirePendingCarry(ctx);
    ctx.send(PUSH.ROOM_INFO, this.roomInfo(ctx.table));
    features.handleRoomFeature(ctx, SEND.SEND_GAME_RANKING_REQ);
    this.onPlayingSnapshot(ctx);
  }

  onPlayingSnapshot(_ctx) {}

  pushRoomSnapshot(ctx) {
    // Robot traffic already sends JOIN/CARRY/STAND. Skip both ROOM_INFO and
    // its per-player recovery snapshots: 3260 also resets live client UI.
    if (ctx.incrementalSeatUpdates || this.config.incrementalSeatUpdates) return;
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(ctx.table));
    // ROOM_INFO clears the client's current hand. Restore per-player state
    // after a seat/member update without broadcasting anyone's private cards.
    if (!ctx.table.hand || !ctx.io.send) return;
    ctx.io.forEachPlayer?.((session) => this.onPlayingSnapshot({ ...ctx, session,
      send: (id, payload) => ctx.io.send(session.ws, id, payload) }));
  }

  onMessage(ctx, msgid, payload) {
    if (features.handleRoomFeature(ctx, msgid, payload)) return true;
    ctx.body = payload || {};
    if (msgid === SEND.CARRY_OUT_REQ) return this.onCarryOut(ctx);
    if (msgid === SEND.SEND_NEXT_ROUND_STANDUP) {
      const member = ctx.table.members.find(item => item.uid === ctx.session.userId);
      if (member) {
        member.standAfterRound = !member.standAfterRound;
        ctx.send(PUSH.NEXT_ROUND_STANDUP_RES, member.standAfterRound);
        if (member.standAfterRound && !ctx.table.hand) this.onStandUp(ctx);
      }
      return true;
    }
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
    if (table.admissionTask || table.roundAdmission || table.partialCarryOut) return;
    const now = Date.now();
    this.expirePendingCarry(ctx, now);
    if (lifecycle.isExpired(table, now)) {
      if (!table.closing && table.phase === "playing") this.playTick(ctx, now);
      return;
    }
    if (table.standby) return;
    if (!lifecycle.syncActivity(table, now)) return;
    robot.tickRoom(this, ctx, now);
    if (this.seated(table).length < this.minPeople(table) && table.phase === "starting") table.phase = "idle";
    this.queueStart(table);
    if (table.phase === "starting" && now >= table.startAt) {
      // Rotate spectator wire coordinates only between hands, after the
      // settlement delay. Incremental bot joins must not reset a live scene.
      ctx.io.prepareRoundSeats?.(this.roomInfo(table));
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
    const person = member || (table.observers || []).find((item) => item.uid === uid);
    const completedBeforeLeave = table.roomFeatures?.totalHands || 0;
    if (!member) {
      table.observers = (table.observers || []).filter((item) => item.uid !== uid);
      lifecycle.noteDeparture(table, person, completedBeforeLeave);
      ctx.io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
      features.pushObservers(ctx);
      return 0;
    }
    if (this.holdSeatUntilRoundEnd(table, member)) {
      member.pendingDeparture = true;
      member.departureSession = ctx.session;
      member.standAfterRound = true;
      table.observers = table.observers.filter(item => item.uid !== uid);
      lifecycle.noteDeparture(table, member, completedBeforeLeave);
      ctx.io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
      features.pushObservers(ctx);
      return 0;
    }
    if (!(member.carryDeadline > 0 && member.point === 0)) this.abandonIfPlaying(ctx, member);
    const cash = member.point || 0;
    features.recordCarryOut(table, member, cash);
    table.members = table.members.filter((item) => item.uid !== uid);
    table.observers = (table.observers || []).filter((item) => item.uid !== uid);
    lifecycle.noteDeparture(table, person, completedBeforeLeave);
    ctx.io.broadcast(PUSH.USER_STANDUP_ROOM, uid);
    ctx.io.broadcast(PUSH.USER_LEVEL_ROOM, { roomId: table.roomId, uid, type: 1 });
    this.pushRoomSnapshot(ctx);
    features.pushObservers(ctx);
    return cash;
  }

}
