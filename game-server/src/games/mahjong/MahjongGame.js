import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { PROTOCOL } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
export class MahjongGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) { const r = roomRules(row); return { roomRules: r, ante: r.diFen, carryMin: r.carryMin, playMode: r.playMode }; }
  roomPolicy(table) { return roomRules(table.cfg); }
  params(table) {
    const r = table.hand?.rules || table.roomRules, names = { jsmj: '极速麻将', csmj: '长沙麻将', hzxl: '红中血流' };
    return { ...r, observed: true, gameTime: 28800, carryMax: -1, carryDefault: 0, betTime: 0,
      autoCreate: true, openTaxNoLimit: true, banEmulator: false,
      gameName: `${names[r.family]}${r.maxPeople === 2 ? '二人' : '四人'}(底注${r.diFen / 100})` };
  }
  buildConf(table) {
    const r = table.roomRules;
    return { roomType: r.family, [r.family + 'Params']: this.params(table), playMode: r.playMode,
      minPeople: 2, maxPeople: r.maxPeople, gameRoomConfigId: Number(table.cfg.game_room_config_id),
      roomClassification: r.roomClassification, allowCarryOut: true, hundredSwitch: false };
  }
  extraRoomInfo(table) {
    const r = table.roomRules;
    return { [r.family]: this.params(table), carryMin: r.carryMin, disusePoint: r.carryMin,
      playMode: r.playMode, roomClassification: r.roomClassification, disbandRoom: false,
      allowCarryOut: true, chatHistory: [] };
  }
  holdSeatUntilRoundEnd(table, member) { return table.hand?.players.some(p => p.uid === member.uid) || false; }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    if (super.onMessage(ctx, id, body)) return true;
    const r = ctx.table.roomRules, msg = PROTOCOL[r.family];
    if (id === msg.action) return engine.action(ctx.io, ctx.table, ctx.session.userId, body);
    if (id === 3653 && r.family === 'hzxl') return engine.exchange(ctx.io, ctx.table, ctx.session.userId, body.cards);
    if (id === 3652 && r.family === 'hzxl') return engine.chooseQue(ctx.io, ctx.table, ctx.session.userId, body.type);
    if (id === msg.query) {
      const p = ctx.table.hand?.players.find(p => p.uid === ctx.session.userId);
      // A recorder sees only public discards and the requesting player's hand.
      ctx.send(msg.queryPush, r.family === 'hzxl' ? engine.recorder(ctx.table, ctx.session.userId) : p ? engine.tingMap(ctx.table, p) : {}); return true;
    }
    if (id === msg.history) { ctx.send(msg.historyPush, engine.historyPayload(ctx.table, body, ctx.session.userId)); return true; }
    if (id === 5006) { this.queueStart(ctx.table); return true; }
    return false;
  }
  startRound(ctx) { engine.begin(ctx.io, ctx.table); }
  playTick(ctx, now) { engine.tick(ctx.io, ctx.table, now); }
}
export default new MahjongGame();
