import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { HundredGame } = await rel(import.meta.url, './HundredGame.js', v);
const { SEND, PUSH } = await rel(import.meta.url, '../messages.js', v);
const { configuredHundredRooms } = await rel(import.meta.url, './hundred-subscriptions.js', v);
const owner = await rel(import.meta.url, './hundred-table-owner.js', v);
const bankers = await rel(import.meta.url, './hundred-banker.js', v);

export class CardShoeGame extends HundredGame {
  constructor(config, engine, history) {
    super(config); this.engine = engine; this.history = history;
  }

  extraTableFields(roomRow) {
    const playMode = Number(roomRow?.play_mode || 0);
    if (!Number.isInteger(playMode) || !Object.hasOwn(this.config.modeNames, playMode)) throw new Error('Unsupported card-shoe playMode');
    const decks = this.config.decks || 8;
    const deck = this.engine.makeShoe(decks);
    return {
      totalCardsNum: decks * 52,
      remainCardsNum: deck.length,
      cutIndex: this.config.cutIndex,
      collectCardCount: 0,
      dealCardCount: 0,
      dealRealCount: 0,
      supplyState: 1,
      ways: { 1: [], 9: [] },
      deck,
      deckPos: 0,
      lastResult: null,
      playMode, state: playMode === 3 ? 1 : 2, cardColor: 0,
      roomIndex: Number(roomRow?.room_index || 1),
    };
  }

  createAreas() {
    return this.engine.emptyAreas(this.config.odds);
  }

  betOptions(table) {
    const options = super.betOptions(table);
    const prices = this.engine.currentOdds(table);
    return { ...options, areas: options.areas.filter(area => prices[area.areaId]?.oddsList.some(n => n > 0))
      .map(area => ({ ...area, odds: Math.max(...prices[area.areaId].oddsList) / 100 })) };
  }

  buildConf(table) {
    return this.engine.roomConf(table);
  }

  enterSnapshot(table, session) {
    return this.engine.enterSnapshot(table, session);
  }

  multiRoomSnapshot(table, session) {
    return this.engine.multiRoomSnapshot?.(table, session) ?? this.enterSnapshot(table, session);
  }

  enter(table, session) {
    super.enter(table, session); bankers.bind(table, session);
  }

  siblingRoomPayload(table) {
    return { ...super.siblingRoomPayload(table), playMode: table.playMode,
      ...this.multiRoomSnapshot(table, { userId: 0, wallet: 0 }) };
  }

  placeBet(ctx, body = {}, responseId = PUSH.BET_RESPONSE) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      ctx.send(responseId, { roomType: ctx.table.roomType, roomId: ctx.table.roomId,
        code: 1, points: ctx.session.wallet, customData: 2 }); return false;
    }
    if (!owner.canBet(ctx.table, ctx.session) || bankers.isBanker(ctx.table, ctx.session.userId)) {
      ctx.send(responseId, { roomType: ctx.table.roomType, roomId: ctx.table.roomId, code: 1,
        points: ctx.session.wallet, customData: body.customData ?? 2 }); return false;
    }
    if (!ctx.table.preparedHand && ctx.table.state === 2) this.engine.prepareHand(ctx.io, ctx.table);
    const options = this.betOptions(ctx.table);
    if (Array.isArray(body.params) && body.params.some(bet => !Number.isSafeInteger(Number(bet?.total) * Math.round((options.areas.find(a => a.areaId === Number(bet?.areaId))?.odds || 0) * 100)))) {
      ctx.send(responseId, { roomType: ctx.table.roomType, roomId: ctx.table.roomId, code: 1,
        points: ctx.session.wallet, customData: body.customData ?? 2 });
      return false;
    }
    const accepted = super.placeBet(ctx, body, responseId);
    if (accepted) owner.afterBet(ctx);
    return accepted;
  }

  async onMessage(ctx, id, body = {}) {
    if (owner.handle(ctx, id, body)) return true;
    if (bankers.request(ctx, id, body, this.config.bankerAreas, ctx.table.playMode !== 4)) return true;
    if (id === SEND.ENTER) owner.enter(ctx, body);
    if (id === SEND.GR_GET_ALL_ROOMS_REQ) {
      ctx.send(PUSH.GR_GET_ALL_ROOMS_RES, configuredHundredRooms(ctx.runtime, this, ctx.session).map(t => this.siblingRoomPayload(t)));
      return true;
    }
    if (id === SEND.REQUEST_100_RECORD || id === SEND.REQUEST_ONE_RECORD) {
      if (id === SEND.REQUEST_ONE_RECORD) {
        const data = await this.history.detail(ctx, Number(body.currInning));
        if (data) { ctx.send(PUSH.RETURN_ONE_RECORD, data); return true; }
      }
      ctx.send(PUSH.RETURN_100_RECORD, await this.history.list(ctx)); return true;
    }
    if (id === 6107) {
      ctx.send(PUSH.PLAYER_NUM_CHANGE, { roomId: ctx.table.roomId, roomType: ctx.table.roomType, playerNum: ctx.table.people }); return true;
    }
    const handled = super.onMessage(ctx, id, body);
    if (id === SEND.ENTER) ctx.send(6243, bankers.list(ctx.table, this.config.bankerAreas));
    return handled;
  }

  robotsEnabled(table) { return table.playMode !== 4; }

  onLeave(ctx) { owner.leave(ctx); bankers.leave(ctx.table, ctx.session); return super.onLeave(ctx); }

  onCycle(ctx, cycle) {
    if (cycle === 0 || cycle === 1) {
      if (!ctx.table.preparedHand) ctx.table.config = this.config;
    }
    if (cycle === 0 || cycle === 1) {
      const task = bankers.boundary(ctx, this.config.bankerAreas);
      if (task?.then) return task.then(() => this.engine.applyCycle(ctx.io, ctx.table, cycle));
    }
    return this.engine.applyCycle(ctx.io, ctx.table, cycle);
  }

  phasesFor(table) { return this.engine.phasesFor(table); }

  beforeTick(ctx) {
    this.engine.migrateTable(ctx.table, this.config);
    if (!ctx.table.preparedHand && !ctx.table.lastResult && [1, 2].includes(ctx.table.state)) {
      ctx.table.config = this.config;
      this.engine.prepareHand(ctx.io, ctx.table);
    }
  }

  pushState(ctx) {
    const table = ctx.table;
    ctx.io.broadcast(PUSH.MB_SNC_ROOM_STATE, { ...this.multiRoomSnapshot(table, { userId: 0, wallet: 0 }), customData: 2 });
    ctx.io.broadcast(PUSH.GAME_STATE, {
      roomType: table.roomType, roomId: table.roomId, countDown: Math.max(0, table.phaseEndsAt - Date.now()),
      state: table.state,
      inning: table.inning,
      ways: this.engine.roadSnapshot(table), areaOdds: this.engine.currentOdds(table),
      ...this.engine.publicState(table),
    });
  }
}

