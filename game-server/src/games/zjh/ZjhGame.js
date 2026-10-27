import { rel } from "../../rel.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
const { SEND, PUSH } = await rel(import.meta.url, "../../messages.js", v);
const { ZJH_SEND } = await rel(import.meta.url, "./messages.js", v);
const { default: config, roomRules } = await rel(import.meta.url, "./config.js", v);
const { SeatGame } = await rel(import.meta.url, "../../core/SeatGame.js", v);
const engine = await rel(import.meta.url, "./engine.js", v);

export class ZjhGame extends SeatGame {
  constructor() {
    super(config);
  }

  extraTableFields(roomRow) {
    let payload = {};
    try { payload = JSON.parse(roomRow?.payload || "{}"); } catch {}
    const params = { ...payload, ...(payload.ctjhParams || {}), ...(roomRow || {}) };
    const n = (key, fallback) => {
      const value = Number(params[key]);
      return Number.isFinite(value) && value > 0 ? value : fallback;
    };
    return {
      roomRules: roomRules(roomRow),
      ante: n("ante", this.config.defaultAnte),
      carryMin: n("carry_min", this.config.defaultCarryMin),
      forceShowCard: roomRow?.force_show_card === undefined ? this.config.forceShowCard : Number(roomRow.force_show_card) === 1,
      forceShowType: [0, 1, 2].includes(Number(params.force_show_type ?? params.forceShowType))
        ? Number(params.force_show_type ?? params.forceShowType) : 1,
      playMode: n("play_mode", 3),
      betTime: n("bet_time", n("betTime", this.config.betTime)),
      maxRounds: Math.floor(n("max_rounds", n("maxRounds", this.config.maxRounds))),
      roomClassification: n("room_classification", n("roomClassification", 2)),
      history: [],
    };
  }

  roomPolicy(table) {
    return roomRules(table?.cfg, table);
  }

  shouldStandAfterRound(table, member) {
    return member.point <= this.roomPolicy(table).disusePoint;
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

  holdSeatUntilRoundEnd(table, member) {
    // Comparison losers and winners are final for that action, but the native
    // animation has not finished. Shared settlement owns their delayed payout.
    return Boolean(table.hand?.comparisonPause
      && engine.participants(table).some(p => p.uid === member.uid));
  }

  onLoginRoom(ctx) {
    ctx.send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
    super.onLoginRoom(ctx);
  }

  onPlayingSnapshot(ctx) {
    engine.pushPlayingSnapshot(ctx.send, ctx.table, ctx.session);
  }

  onMessage(ctx, msgid, payload) {
    const common = super.onMessage(ctx, msgid, payload);
    if (common) return common;
    if (msgid === SEND.LOGIN_ROOM) {
      this.onLoginRoom(ctx);
      return true;
    }
    if (msgid === ZJH_SEND.ACTION) {
      engine.onZjhAction(ctx.io, ctx.table, ctx.session, payload || {});
      return true;
    }
    if (msgid === ZJH_SEND.HAND_CARD) {
      engine.onHandCardReq(ctx.send, ctx.table, ctx.session);
      return true;
    }
    if (msgid === ZJH_SEND.SHOW_CARD) {
      engine.onShowCardReq(ctx.send, ctx.table, ctx.session, payload || {});
      return true;
    }
    if (msgid === ZJH_SEND.GAME_BACK) {
      ctx.send(3746, engine.historyPayload(ctx.runtime?.env === "dev" ? ctx.table
        : { ...ctx.table, history: [] }, payload || {}, ctx.session.userId));
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
