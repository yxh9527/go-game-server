import { rel } from "../../rel.js";
import config from "./config.js";

const v = new URL(import.meta.url).searchParams.get("v") || "0";
const { SEND, PUSH } = await rel(import.meta.url, "../../messages.js", v);
const { SeatGame } = await rel(import.meta.url, "../../core/SeatGame.js", v);
const engine = await rel(import.meta.url, "./engine.js", v);
const { holdemRoomSettings, assertHoldemPlayable } = await rel(import.meta.url, "../../../../shared/holdem-room.js", v);
const { initializeCritical } = await rel(import.meta.url, "./critical.js", v);
const { blindAt,tournamentRestSeconds } = await rel(import.meta.url, '../../core/tournament-blinds.js', v);
const {queryHoldemReplay}=await rel(import.meta.url,'../../../../shared/holdem-replay-store.js',v);

export class HoldemGame extends SeatGame {
  constructor() {
    super(config);
  }

  extraTableFields(roomRow) {
    assertHoldemPlayable(roomRow);
    const fields = {
      ...holdemRoomSettings(roomRow),
      criticalFlag: Number(roomRow?.room_type) !== 101 && holdemRoomSettings(roomRow).criticalFlag,
      playMode: engine.holdemPlayMode(roomRow),
      betTime: this.config.betTime,
    };
    initializeCritical(fields);
    return fields;
  }

  buildConf(table) {
    if (table.mtt) return { ...engine.texasConf(table), ...engine.dzpkParams(table),
      roomType: 19, isMtt: true, mttId: table.mtt.id, gameRoomConfigId: 0,
      playMode: 0, allowCarryOut: false, hundredSwitch: false };
    return engine.texasConf(table);
  }

  extraRoomInfo(table) {
    return {
      playMode: table.playMode,
      dzpk: engine.dzpkParams(table),
    };
  }

  defaultBuyIn(table) {
    if(table.playMode===9)return Math.max(table.carryMin,table.aofBet);
    return Math.max(table.carryMin, table.bigBlind * this.config.buyInBb);
  }

  seated(table){return table.playMode===9?super.seated(table).filter(p=>p.point>=table.aofBet):super.seated(table);}

  shouldStandAfterRound(table,member){return super.shouldStandAfterRound(table,member)||table.playMode===9&&member.point<table.aofBet;}

  onLoginRoom(ctx) {
    ctx.send(PUSH.DZPK_PUSH_GAME_SETTING, { result: true, type: 0 });
    super.onLoginRoom(ctx);
    if(ctx.table.mtt){
      ctx.send(4110,{mttId:ctx.table.mtt.id,championshipName:ctx.table.mtt.config.name||'[]',delayRegisterLevel:ctx.table.mtt.config.lateLevel||0,reBuyTime:ctx.table.mtt.config.rebuyLimit||0});
      ctx.send(4199,Math.max(0,Number(ctx.table.mtt.config.rebuyLimit||0)-(ctx.table.mtt.reentries?.get(ctx.session.userId)||0)));
      ctx.send(20009,blindAt(ctx.table.mtt.config,Date.now(),ctx.table.mtt.clock));
      if(ctx.table.mtt.clock?.pauseRequested)ctx.send(20013);
      if(ctx.table.mtt.clock?.waitingIndex!=null){
        const seconds=tournamentRestSeconds(ctx.table.mtt.clock);
        ctx.send(seconds>0?20014:20013,seconds>0?seconds:undefined);
      }
      const result=ctx.table.mtt.finalResults?.get(ctx.session.userId);
      if(result)ctx.send(20010,result);
    }
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
    if (msgid === SEND.DZPK_SEND_ACTION) {
      engine.onTexasAction(ctx.io, ctx.table, ctx.session, payload || {});
      return true;
    }
    if (msgid === SEND.DZPK_HAND_CARD_REQ) {
      engine.onHandCardReq(ctx.send, ctx.table, ctx.session);
      return true;
    }
    if (msgid === SEND.DZPK_SHOW_CARD_REQ) {
      engine.onShowCardReq(ctx.send, ctx.table, ctx.session, payload || {});
      return true;
    }
    if (msgid === SEND.GTO_REQ) {
      engine.onGtoReq(ctx.send, payload || {});
      return true;
    }
    if (msgid === SEND.DZPK_SEND_GAME_BACK_REQ) {
      if(ctx.runtime?.env==='prod')return queryHoldemReplay(ctx.runtime,{userId:ctx.session.userId,agentId:ctx.session.agentId,currency:ctx.session.currency},
        {...payload,roomId:ctx.table.roomId,roomType:ctx.table.roomType,roomCreatedAt:ctx.table.createdAt,beginNum:payload?.beginNum??-1,endNum:payload?.endNum??-1})
        .then(data=>{ctx.send(PUSH.DZPK_PUSH_GAME_BACK_MSG,data);return true;});
      // Only development has room-local in-memory history. Production replay
      // must be served through data-center/Redis once its replay query contract
      // is available; never expose a process-local partial history there.
      const table = ctx.runtime?.env === "dev"
        ? ctx.table
        : { ...ctx.table, history: [] };
      ctx.send(PUSH.DZPK_PUSH_GAME_BACK_MSG, engine.texasHistoryPayload(table, payload || {}));
      return true;
    }
    return false;
  }

  startRound(ctx) {
    if(ctx.table.mtt){
      if(ctx.table.mtt.clock?.waitingIndex!=null)return;
      const blind=blindAt(ctx.table.mtt.config,Date.now(),ctx.table.mtt.clock);
      Object.assign(ctx.table,{smallBlind:blind.smallBlind,bigBlind:blind.bigBlind,initialBet:blind.ante,ante:blind.ante});
      ctx.table.mtt.level=blind.index;ctx.io.broadcast(20009,blind);
    }
    return engine.beginHand(ctx.io, ctx.table);
  }

  playTick(ctx, now) {
    return engine.tickPlaying(ctx.io, ctx.table, now);
  }

  abandonIfPlaying(ctx, member) {
    engine.foldIfPlaying(ctx.io, ctx.table, member.uid);
  }
}

export default new HoldemGame();
