import { SeatGame } from "../../core/SeatGame.js";
import { SEND, PUSH } from "../../messages.js";
import config from "./config.js";
import * as engine from "./engine.js";

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
        carryMin: table.carryMin,
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
    engine.ensureBot(table);
  }

  onJoin(ctx) {
    super.onJoin(ctx);
    ctx.send(PUSH.DZPK_PUSH_WATCHGAME, ctx.table.observers);
  }

  onLoginRoom(ctx) {
    ctx.send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
    super.onLoginRoom(ctx);
  }

  onPlayingSnapshot(ctx) {
    engine.pushPlayingSnapshot(ctx.send, ctx.table, ctx.session);
  }

  onMessage(ctx, msgid, payload) {
    if (msgid === SEND.LOGIN_ROOM) {
      this.onLoginRoom(ctx);
      return true;
    }
    if (msgid === SEND.DZPK_SEND_ACTION) {
      engine.onTexasAction(ctx.io, ctx.table, ctx.session, payload || {});
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
