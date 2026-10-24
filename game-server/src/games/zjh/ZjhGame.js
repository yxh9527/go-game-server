import { SEND, PUSH } from "../../messages.js";
import config from "./config.js";
import { rel } from "../../rel.js";
import { ZJH_SEND } from "./messages.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
const { SeatGame } = await rel(import.meta.url, "../../core/SeatGame.js", v);
const engine = await rel(import.meta.url, "./engine.js", v);

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

  defaultBuyIn(table) {
    return Math.max(table.carryMin, table.ante * this.config.buyInMultiple);
  }

  onLoginRoom(ctx) {
    ctx.send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
    super.onLoginRoom(ctx);
  }

  onMessage(ctx, msgid, payload) {
    if (super.onMessage(ctx, msgid, payload)) return true;
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
