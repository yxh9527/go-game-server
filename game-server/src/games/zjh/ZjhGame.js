import { SeatGame } from "../../core/SeatGame.js";
import { SEND, PUSH } from "../../messages.js";
import config from "./config.js";
import * as engine from "./engine.js";
import { ZJH_SEND } from "./messages.js";

export class ZjhGame extends SeatGame {
  constructor() {
    super(config);
  }

  extraTableFields(roomRow) {
    const n = (key, fallback) => {
      const value = Number(roomRow?.[key]);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
      ante: n("ante", this.config.defaultAnte) || n("small_blind", this.config.defaultAnte) || this.config.defaultAnte,
      carryMin: n("carry_min", this.config.defaultCarryMin),
      forceShowCard: roomRow?.force_show_card === undefined ? this.config.forceShowCard : Number(roomRow.force_show_card) === 1,
      playMode: n("play_mode", 3),
      betTime: this.config.betTime,
      maxRounds: this.config.maxRounds,
    };
  }

  buildConf(table) {
    return engine.zjhConf(table);
  }

  extraRoomInfo(table) {
    return engine.extraRoomInfo(table);
  }

  buyIn(table, session) {
    return Math.min(
      Math.max(Number(session.wallet) || 0, 0),
      Math.max(table.carryMin, table.ante * this.config.buyInMultiple),
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

  onMessage(ctx, msgid, payload) {
    if (msgid === SEND.LOGIN_ROOM) {
      this.onLoginRoom(ctx);
      return true;
    }
    if (msgid === ZJH_SEND.ACTION) {
      engine.onZjhAction(ctx.io, ctx.table, ctx.session, payload || {});
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

export default new ZjhGame();
