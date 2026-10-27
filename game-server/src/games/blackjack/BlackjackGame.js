import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { SEND, PUSH } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
export class BlackjackGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) { const rules = roomRules(row); return { roomRules: rules, ante: rules.ante,
    carryMin: rules.carryMin, playMode: 0, houseNetScore: 0, history: [] }; }
  roomPolicy(table) { return roomRules(table.cfg); }
  params(table) { return table.hand?.rules || table.roomRules; }
  buildConf(table) { return { roomType: 'bj21', bj21Params: this.params(table), playMode: 0,
    gameRoomConfigId: Number(table.cfg.game_room_config_id), maxPeople: 3, allowCarryOut: true, hundredSwitch: false }; }
  extraRoomInfo(table) { return { bj21: this.params(table), playMode: 0, gameState: engine.gameState(table),
    roomStart: true, allowCarryOut: true, chatHistory: [], roomClassification: Number(table.cfg.room_classification) || 2 }; }
  holdSeatUntilRoundEnd(table, member) { return table.hand?.players.some(p => p.uid === member.uid) || false; }
  onJoin(ctx) { super.onJoin(ctx); ctx.send(2206, this.roomInfo(ctx.table)); }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    if (super.onMessage(ctx, id, body)) return true;
    if (id === SEND.START) { this.queueStart(ctx.table); return true; }
    if (id === SEND.HISTORY) { ctx.send(PUSH.HISTORY, engine.historyPayload(ctx.table, body, ctx.session.userId)); return true; }
    if (Object.values(SEND).includes(id)) {
      const ok = engine.act(ctx.io, ctx.table, ctx.session.userId, id, body);
      if (!ok) ctx.send(PUSH.TIP, { code: 1 });
      return true;
    }
    return false;
  }
  startRound(ctx) { engine.begin(ctx.io, ctx.table); }
  playTick(ctx, now) {
    const hand = ctx.table.hand;
    engine.tick(ctx.io, ctx.table, now);
    // END has consumed the round interval. Reuse common payout, admission and
    // lifecycle guards now instead of adding another one-second server tick.
    if (hand && !ctx.table.hand && !this.afterRound(ctx)) super.tick(ctx);
  }
}
export default new BlackjackGame();
