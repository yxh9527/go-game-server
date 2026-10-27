import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { SEND, PUSH } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);

export class SssGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) {
    const rules = roomRules(row);
    return { roomRules: rules, ante: rules.ante, carryMin: rules.carryMin, playMode: rules.playMode, history: [] };
  }
  roomPolicy(table) { return roomRules(table.cfg); }
  params(table) { const r = table.hand?.rules || table.roomRules; return { ...r, playerCount: r.maxPeople }; }
  buildConf(table) {
    return { roomType: 'sss', sssParams: this.params(table), playMode: table.playMode,
      gameRoomConfigId: Number(table.cfg.game_room_config_id), maxPeople: this.maxPeople(table),
      disusePoint: table.roomRules.disusePoint, allowCarryOut: true, hundredSwitch: false };
  }
  extraRoomInfo(table) {
    return { sss: this.params(table), playMode: table.playMode, gameState: engine.gameState(table),
      disusePoint: table.roomRules.disusePoint, allowCarryOut: true, chatHistory: [],
      roomClassification: Number(table.cfg.room_classification) || 2 };
  }
  holdSeatUntilRoundEnd(table, member) { return table.hand?.players.some(p => p.uid === member.uid) || false; }
  onJoin(ctx) {
    super.onJoin(ctx);
    ctx.send(2206, this.roomInfo(ctx.table));
  }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    if (super.onMessage(ctx, id, body)) return true;
    if (id === SEND.ARRANGE) return engine.arrange(ctx.io, ctx.table, ctx.session.userId, body);
    if (id === SEND.START) { this.queueStart(ctx.table); return true; }
    if (id === SEND.HISTORY) { ctx.send(PUSH.HISTORY, engine.historyPayload(ctx.table, body, ctx.session.userId)); return true; }
    if (id === SEND.ADD_TIME) {
      return engine.addTime(ctx.io, ctx.table, ctx.session.userId);
    }
    return false;
  }
  startRound(ctx) { engine.begin(ctx.io, ctx.table); }
  playTick(ctx, now) { engine.tick(ctx.io, ctx.table, now); }
}
export default new SssGame();
