import { SEND, PUSH } from "../messages.js";
import { GameBase } from "./GameBase.js";

export class SlotsGame extends GameBase {
  createTable(roomId, roomType, roomRow) {
    return {
      ...super.createTable(roomId, roomType, roomRow),
      gameRoomId: Number(roomId) + 1000000,
      history: [],
      roomIndex: Number(roomRow?.room_index || this.config.defaultRoomIndex || 0),
    };
  }

  playerState(table, session) {
    return {
      code: 0,
      roomId: table.roomId,
      gameRoomId: table.gameRoomId,
      roomTypeCode: table.roomType,
      walletAmount: session.wallet,
    };
  }

  buy(_ctx, _payload) {
    return null;
  }

  historyPayload(table) {
    return {
      gameRoomId: table.gameRoomId,
      winInfo: table.history || [],
    };
  }

  async onMessage(ctx, msgid, payload) {
    if (msgid === SEND.GGL_STATE) {
      ctx.send(PUSH.GGL_STATE, await this.playerState(ctx.table, ctx.session, ctx));
      return true;
    }
    if (msgid === SEND.GGL_BUY) {
      const result = await this.buy(ctx, payload || {});
      if (result) {
        ctx.send(PUSH.GGL_RESULT, result);
      }
      return true;
    }
    if ([SEND.REQUEST_100_RECORD, SEND.RETURN_100_RECORD].includes(msgid)) {
      ctx.send(PUSH.RETURN_100_RECORD, await this.historyPayload(ctx.table, ctx.session, ctx));
      return true;
    }
    return false;
  }
}
