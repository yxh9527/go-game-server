import { SeatGame } from "../../core/SeatGame.js";
import { SEND, PUSH } from "../../messages.js";
import { rel } from "../../rel.js";
import config from "./config.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
const engine = await rel(import.meta.url, "./engine.js", v);

export class HoldemGame extends SeatGame {
  constructor() {
    super(config);
  }

  extraTableFields(roomRow) {
    const n = (key, fallback) => {
      const value = Number(roomRow?.[key]);
      return Number.isFinite(value) ? value : fallback;
    };
    return {
      smallBlind: n("small_blind", this.config.defaultSmallBlind),
      bigBlind: n("big_blind", this.config.defaultBigBlind),
      carryMin: n("carry_min", this.config.defaultCarryMin),
      forceShowCard: Number(roomRow?.force_show_card) === 1,
      playMode: n("play_mode", 0),
      roomClassification: 2,
      betTime: this.config.betTime,
    };
  }

  buildConf(table) {
    return engine.texasConf(table);
  }

  extraRoomInfo(table) {
    return {
      dzpk: {
        gameName: this.config.name,
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        initialBet: table.bigBlind,
        carryMin: table.carryMin,
        carryMax: -1,
        betTime: table.betTime,
        forceShowCard: table.forceShowCard,
        openInsurance: this.config.openInsurance,
      },
    };
  }

  buyIn(table, session) {
    return Math.min(
      Math.max(Number(session.wallet) || 0, 0),
      Math.max(table.carryMin, table.bigBlind * this.config.buyInBb),
    );
  }

  afterSit(table) {
    engine.ensureBots(table);
    this.queueStart(table);
  }

  queueStart(table) {
    const ready = this.seated(table);
    const hasHuman = ready.some((member) => !member.bot);
    const hasCashTableObserver = Number(table.roomType) === 19 && (table.observers || []).length > 0;
    if (table.phase !== "idle" || (!hasHuman && !hasCashTableObserver) || ready.length < this.minPeople()) {
      return;
    }
    table.phase = "starting";
    table.startAt = Date.now() + (this.config.startDelayMs || 3000);
  }

  onJoin(ctx) {
    super.onJoin(ctx);
    engine.ensureBots(ctx.table);
    this.queueStart(ctx.table);
    ctx.io.broadcast(PUSH.ROOM_INFO, this.roomInfo(ctx.table));
    ctx.send(PUSH.DZPK_PUSH_WATCHGAME, this.roomInfo(ctx.table).OBmemberList);
  }

  onLoginRoom(ctx) {
    ctx.send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
    super.onLoginRoom(ctx);
  }

  onPlayingSnapshot(ctx) {
    engine.pushPlayingSnapshot(ctx.send, ctx.table, ctx.session);
  }

  onLeave(ctx) {
    const cash = super.onLeave(ctx);
    const table = ctx.table;
    if (!table.observers.length && !table.members.some((member) => !member.bot)) {
      table.members = [];
      table.hand = null;
      table.phase = "idle";
      table.startAt = 0;
    }
    return cash;
  }

  onMessage(ctx, msgid, payload) {
    if (super.onMessage(ctx, msgid, payload)) {
      return true;
    }
    if (msgid === SEND.LOGIN_ROOM) {
      this.onLoginRoom(ctx);
      return true;
    }
    if (msgid === SEND.DZPK_SEND_ACTION) {
      engine.onTexasAction(ctx.io, ctx.table, ctx.session, payload || {});
      return true;
    }
    if (msgid === SEND.GTO_REQ) {
      engine.onGtoReq(ctx.send, payload || {});
      return true;
    }
    return false;
  }

  startRound(ctx) {
    engine.beginHand(ctx.io, ctx.table);
  }

  playTick(ctx, now) {
    engine.tickPlaying(ctx.io, ctx.table, now);
  }

  abandonIfPlaying(ctx, member) {
    engine.foldIfPlaying(ctx.io, ctx.table, member.uid);
  }
}

export default new HoldemGame();
