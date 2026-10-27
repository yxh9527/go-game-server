import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { SeatGame } = await rel(import.meta.url, '../../core/SeatGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const { SEND, PUSH } = await rel(import.meta.url, './messages.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
const casino = await rel(import.meta.url, './casino.js', v);
const features = await rel(import.meta.url, '../../core/room-features.js', v);
export class BlackjackGame extends SeatGame {
  constructor() { super(config); }
  extraTableFields(row) { const rules = roomRules(row); return { roomRules: rules, ante: rules.ante,
    carryMin: rules.carryMin, playMode: rules.playMode, houseNetScore: 0, history: [] }; }
  roomPolicy(table) { return roomRules(table.cfg); }
  params(table) { return table.hand?.rules || table.roomRules; }
  buildConf(table) { return { roomType: 'bj21', bj21Params: this.params(table), playMode: table.playMode,
    gameRoomConfigId: Number(table.cfg.game_room_config_id), maxPeople: this.maxPeople(table), allowCarryOut: true, hundredSwitch: false }; }
  extraRoomInfo(table) { return { bj21: this.params(table), playMode: table.playMode, gameState: engine.gameState(table),
    roomStart: true, allowCarryOut: true, chatHistory: [], roomClassification: Number(table.cfg.room_classification) || 2 }; }
  sit(table, session, host, opts = {}) {
    const member = super.sit(table, session, host, opts);
    if (member && casino.isCasino(table)) {
      member.displaySeat = casino.displaySeat(member.pos);
      casino.bindWalletSeat(member, session);
    }
    return member;
  }
  publicMember(member) {
    const result = super.publicMember(member);
    if (member.displaySeat !== undefined) result.displaySeat = member.displaySeat;
    if (member.casinoWalletSession) result.point = casino.availablePoint(member);
    return result;
  }
  roomInfo(table) {
    const result = super.roomInfo(table);
    if (casino.isCasino(table)) result.memberList = result.memberList.map(m => ({ ...m,
      displaySeat: casino.displaySeat(m.pos), point: casino.availablePoint(table.members.find(member => member.uid === m.uid)) }));
    return result;
  }
  defaultBuyIn(table) { return casino.isCasino(table) ? table.ante * 10 : super.defaultBuyIn(table); }
  seated(table) { return casino.isCasino(table)
    ? table.members.filter(m => !m.pendingDeparture && !m.carryDeadline && casino.availablePoint(m) >= table.ante)
    : super.seated(table); }
  shouldStandAfterRound(table, member) {
    return casino.isCasino(table) ? casino.availablePoint(member) < Math.max(table.ante, table.carryMin)
      : super.shouldStandAfterRound(table, member);
  }
  carryPanel(table, session) {
    const panel = super.carryPanel(table, session);
    return casino.isCasino(table) ? { ...panel, carryMin: table.carryMin || table.ante,
      carryDefault: Math.min(panel.carryMax, Math.max(table.ante, this.params(table).carryDefault)) } : panel;
  }
  onSitDown(ctx) {
    if (casino.isCasino(ctx.table) && !ctx.session.bot) {
      const pos = casino.DISPLAY_SEATS.indexOf(ctx.body?.position ?? ctx.body?.pos);
      if (pos < 0) return;
      const existing = ctx.table.members.find(m => m.uid === ctx.session.userId);
      if (!existing && ctx.session.wallet < ctx.table.ante) {
        casino.betResponse(ctx.io, ctx.table, ctx.session.userId, { targetPos: casino.displaySeat(pos) },
          'CLUB_USER_POINT_NOT_ENOUGH', ctx.session.wallet);
        return;
      }
      const member = this.sit(ctx.table, ctx.session, ctx, { pos, buyIn: 0 });
      if (!member) return;
      ctx.io.broadcast(2202, this.publicMember(member));
      ctx.send(9212, casino.availablePoint(member));
      engine.joinBettingHand(ctx.io, ctx.table, member.uid);
      this.queueStart(ctx.table);
      features.pushObservers(ctx);
      return;
    }
    super.onSitDown(ctx);
  }
  onCarryScore(ctx) {
    const seated = ctx.table.members.find(m => m.uid === ctx.session.userId);
    if (casino.isCasino(ctx.table) && seated?.casinoWalletSession) {
      // Stale/manual ordinary buy-ins must not debit a casino account twice.
      ctx.send(3230, { uid: seated.uid, state: 1, carryIn: 0, carryBalance: casino.availablePoint(seated) });
      return;
    }
    const before = ctx.table.members.find(m => m.uid === ctx.session.userId)?.point;
    super.onCarryScore(ctx);
    const member = ctx.table.members.find(m => m.uid === ctx.session.userId);
    if (casino.isCasino(ctx.table) && member && member.point > before) {
      if (!ctx.session.bot) ctx.io.broadcast(2202, this.publicMember(member));
      engine.joinBettingHand(ctx.io, ctx.table, member.uid);
    }
  }
  holdSeatUntilRoundEnd(table, member) { return table.hand?.players.some(p => p.uid === member.uid) || false; }
  onJoin(ctx) {
    if (casino.isCasino(ctx.table)) casino.bindWalletSeat(ctx.table.members.find(m => m.uid === ctx.session.userId), ctx.session);
    super.onJoin(ctx); ctx.send(2206, this.roomInfo(ctx.table));
  }
  onLoginRoom(ctx) {
    if (casino.isCasino(ctx.table)) casino.bindWalletSeat(ctx.table.members.find(m => m.uid === ctx.session.userId), ctx.session);
    super.onLoginRoom(ctx);
    // JOIN's 9212 can precede asynchronous LiveBlackJack loading. Its onLoad
    // sends LOGIN_ROOM after listeners are installed; restore the balance at
    // that handshake so the native balance handler selects a valid chip.
    if (casino.isCasino(ctx.table)) {
      const member = ctx.table.members.find(m => m.uid === ctx.session.userId);
      ctx.send(9212, member ? casino.availablePoint(member) : ctx.session.wallet);
    }
  }
  afterRound(ctx) {
    const funding = casino.flushWalletFunding(ctx);
    return funding ? funding.then(() => super.afterRound(ctx)) : super.afterRound(ctx);
  }
  onPlayingSnapshot(ctx) { engine.pushSnapshot(ctx.send, ctx.table, ctx.session); }
  onMessage(ctx, id, body = {}) {
    if (super.onMessage(ctx, id, body)) return true;
    if (id === SEND.START) { this.queueStart(ctx.table); return true; }
    if (id === SEND.HISTORY) { ctx.send(PUSH.HISTORY, engine.historyPayload(ctx.table, body, ctx.session.userId)); return true; }
    if (Object.values(SEND).includes(id)) {
      const ok = engine.act(ctx.io, ctx.table, ctx.session.userId, id, body);
      if (!ok && id === SEND.BET && casino.isCasino(ctx.table))
        casino.betResponse(ctx.io, ctx.table, ctx.session.userId, body,
          engine.casinoBetError(ctx.table, ctx.session.userId, body) || 'BET_FAILED', ctx.session.wallet);
      else if (!ok) ctx.send(PUSH.TIP, { code: 1 });
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
