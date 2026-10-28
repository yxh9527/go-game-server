import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { SEND, PUSH } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);

export class SgayGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) {
    const r = roomRules(row);
    return { roomRules: r, ante: r.ante, carryMin: r.carryMin, playMode: 0, history: [] };
  }
  roomPolicy(table) { return roomRules(table.cfg); }
  params(table) {
    const r = table.hand?.rules || table.roomRules;
    return { ...r, playerCount: 7, observed: true, gameTime: 28800, gameStartNum: 2,
      carryMax: -1, carryDefault: 0, betTime: 0, autoCreate: true, openTaxNoLimit: true,
      gameName: `三公暗一(底注${r.ante / 100})` };
  }
  buildConf(table) {
    return { roomType: 'sgya', sgyaParams: this.params(table), playMode: 0, minPeople: 2, maxPeople: 7,
      gameRoomConfigId: Number(table.cfg.game_room_config_id),
      roomClassification: table.roomRules.roomClassification, allowCarryOut: true, hundredSwitch: false };
  }
  extraRoomInfo(table) {
    return { sgya: this.params(table), playMode: 0, gameState: engine.gameState(table),
      roomClassification: table.roomRules.roomClassification, allowCarryOut: true, chatHistory: [] };
  }
  roomInfo(table) {
    const info = super.roomInfo(table);
    // Sgay.inningInfo subtracts xiaZhuData from the preceding 2206 balance.
    // Send opening chips in this network copy; the resident balance is net.
    if (table.hand) info.memberList = info.memberList.map(member => {
      const p = table.hand.players.find(p => p.uid === member.uid);
      return p ? { ...member, point: p.member.point + (p.bet || 0) } : member;
    });
    return info;
  }
  holdSeatUntilRoundEnd(table, member) { return table.hand?.players.some(p => p.uid === member.uid) || false; }
  onLoginRoom(ctx) { ctx.session.sgayHydrateUntil = Date.now() + 2000; super.onLoginRoom(ctx); }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    if (super.onMessage(ctx, id, body)) return true;
    if (id === SEND.ACTION) {
      if ((body.uid != null && Number(body.uid) !== ctx.session.userId) || body.operation !== 1) return false;
      return engine.bet(ctx.io, ctx.table, ctx.session.userId, body.operationData);
    }
    if (id === SEND.SHOW) {
      if (body.isShow !== true || !Number.isInteger(body.card) || body.card < 0 || body.card > 51) return false;
      return engine.show(ctx.io, ctx.table, ctx.session.userId, body);
    }
    if (id === SEND.START) { this.queueStart(ctx.table); return true; }
    if (id === SEND.HISTORY) { ctx.send(PUSH.HISTORY, engine.historyPayload(ctx.table, body, ctx.session.userId)); return true; }
    if (id === 3174) {
      const p = ctx.table.hand?.players.find(p => p.uid === ctx.session.userId);
      ctx.send(3282, { handCard: p ? engine.visibleCards(ctx.table, p, ctx.session.userId) : [], commonCard: [] });
      return true;
    }
    return false;
  }
  startRound(ctx) { engine.begin(ctx.io, ctx.table); }
  playTick(ctx, now) { engine.tick(ctx.io, ctx.table, now); }
}
export default new SgayGame();
