import { SlotsGame } from "../../core/SlotsGame.js";
import * as engine from "./engine.js";

export class GglGame extends SlotsGame {
  createTable(roomId, roomType, roomRow) {
    return engine.createScratchTable(roomId, roomType, roomRow, this.config);
  }

  buildConf(table) {
    return engine.scratchConf(table);
  }

  playerState(table, session) {
    return engine.scratchState(table, session);
  }

  buy(ctx, payload) {
    return engine.buyTicket(ctx.table, ctx.session, payload || {}, ctx);
  }

  historyPayload(table) {
    return {
      gameRoomId: table.gameRoomId,
      winInfo: table.history,
    };
  }
}
