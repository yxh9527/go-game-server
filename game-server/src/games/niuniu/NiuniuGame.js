import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { SEND, PUSH } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);

export class NiuniuGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) {
    const rules = roomRules(row);
    return { roomRules: rules, ante: rules.ante, carryMin: rules.carryMin, playMode: rules.playMode, history: [] };
  }
  roomPolicy(table) { return roomRules(table.cfg, table); }
  params(table) {
    const rules = table.hand?.rules || table.roomRules;
    return { ...rules, playerCount: rules.maxPeople, gameTime: 28800,
      observed: true, autoCreate: true, carryDefault: rules.carryMin, carryMax: -1 };
  }
  buildConf(table) {
    return { roomType: 'qznn', qznnParams: this.params(table), playMode: table.playMode,
      gameRoomConfigId: Number(table.cfg.game_room_config_id), maxPeople: this.maxPeople(table),
      disusePoint: table.roomRules.disusePoint, allowCarryOut: true, hundredSwitch: false };
  }
  extraRoomInfo(table) {
    return { qznn: this.params(table), playMode: table.playMode, laiZi: table.hand?.laiZi ?? -1,
      disusePoint: table.roomRules.disusePoint, allowCarryOut: true, chatHistory: [],
      roomClassification: Number(table.cfg.room_classification) || 2 };
  }
  // Existing banker liabilities remain attached to the funded chair until the
  // hand settles. Shared SeatGame owns delayed cash-out and persistence.
  holdSeatUntilRoundEnd(table, member) {
    return table.hand?.players.some(p => p.uid === member.uid) || false;
  }
  onLoginRoom(ctx) {
    // Original scene LateInit sends 2111 before its asynchronous spine skin
    // finishes. During hydration use snapshots instead of a start animation.
    ctx.session.niuniuHydrateUntil = Date.now() + 2000;
    super.onLoginRoom(ctx);
  }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    const common = super.onMessage(ctx, id, body);
    if (common) return common;
    const uid = ctx.session.userId;
    if (id === SEND.GRAB) return engine.grab(ctx.io, ctx.table, uid, body.count);
    if (id === SEND.BET) return engine.bet(ctx.io, ctx.table, uid, body.multiple);
    if (id === SEND.SHOW) return engine.show(ctx.io, ctx.table, uid);
    if (id === SEND.COMBINE) return engine.combine(ctx.io, ctx.table, uid);
    if (id === SEND.START) { this.queueStart(ctx.table); return true; }
    if (id === SEND.HISTORY) { ctx.send(PUSH.HISTORY, engine.historyPayload(ctx.table, body, uid)); return true; }
    if (id === SEND.AUTO) {
      const m = ctx.table.members.find(p => p.uid === uid);
      if (!m) return false;
      if (body.op === 1) {
        const r = ctx.table.roomRules;
        if (!['specialGrabBank', 'tenGrabBank'].every(k => Number.isSafeInteger(body[k]) && body[k] >= 0 && body[k] <= r.grabBankerMax)
          || !['specialMultiple', 'tenMultiple'].every(k => r.bettingMultiples.includes(body[k]))
          || !['stopLoseAmt', 'stopWinAmt'].every(k => body[k] == null || Number.isFinite(body[k]) && body[k] >= 0)) return false;
        m.niuniuAuto = { ...body, status: 1, startPoint: m.point };
      } else if (body.op === 2 && m.niuniuAuto) m.niuniuAuto.status = 0;
      ctx.send(PUSH.AUTO, { ...(m.niuniuAuto || {}), status: m.niuniuAuto?.status || 0 });
      ctx.io.broadcast(PUSH.AUTO_STATUS, { uid, status: m.niuniuAuto?.status || 0 });
      return true;
    }
    return false;
  }
  startRound(ctx) { engine.begin(ctx.io, ctx.table); }
  playTick(ctx, now) { engine.tick(ctx.io, ctx.table, now); }
}
export default new NiuniuGame();
