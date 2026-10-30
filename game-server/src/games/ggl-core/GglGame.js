import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SlotsGame } = await rel(import.meta.url, '../../core/SlotsGame.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
const { SEND, PUSH } = await rel(import.meta.url, '../../messages.js', v);
export class GglGame extends SlotsGame {
  createTable(roomId, roomType, row) { return engine.createScratchTable(roomId, roomType, row, this.config); }
  buildConf(table) { return engine.scratchConf(table); }
  beforeLeave(ctx) {
    ctx.session.inRoom = false;
    // Queue behind any purchase/reveal already accepted on this connection.
    return engine.scratchState(ctx.table, ctx.session, ctx);
  }
  async onMessage(ctx, msgid, body = {}) {
    const routes = { [SEND.GGL_STATE]: ['state', PUSH.GGL_STATE], [SEND.GGL_BUY]: ['reveal', PUSH.GGL_RESULT],
      [SEND.GGL_SEARCH]: ['search', PUSH.GGL_SEARCH_RESULT], [SEND.GGL_PURCHASE]: ['purchase', PUSH.GGL_PURCHASE_RESULT] };
    if (routes[msgid]) {
      const [method, response] = routes[msgid];
      ctx.send(response, await engine.scratchRequest(ctx, method, body));
      return true;
    }
    if ([SEND.REQUEST_100_RECORD, SEND.RETURN_100_RECORD].includes(msgid)) {
      try { ctx.send(PUSH.RETURN_100_RECORD, await engine.scratchHistory(ctx)); }
      catch (err) { ctx.runtime?.log?.error?.('scratch history failed', err.message); ctx.send(PUSH.RETURN_100_RECORD, { gameRoomId: ctx.table.gameRoomId, code: 100085, winInfo: [] }); }
      return true;
    }
    return false;
  }
}
