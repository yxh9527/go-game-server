import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { HundredGame } = await rel(import.meta.url, '../../core/HundredGame.js', v);
const { PUSH } = await rel(import.meta.url, '../../messages.js', v);
const { default: config } = await rel(import.meta.url, './config.js', v);
const engine = await rel(import.meta.url, './engine.js', v);

export class BaccaratGame extends HundredGame {
  constructor() {
    super(config);
  }

  extraTableFields(roomRow) {
    const decks = this.config.decks || 8;
    const deck = engine.makeShoe(decks);
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
      roomIndex: Number(roomRow?.room_index || 1),
    };
  }

  createAreas() {
    return engine.emptyAreas(this.config.odds);
  }

  betOptions(table) {
    const options = super.betOptions(table);
    // Only areas with an implemented winning condition are open here.
    return { ...options, areas: options.areas.filter(area => [1, 2, 3, 4, 5, 9].includes(area.areaId))
      .map(area => ({ ...area, odds: (table.config || this.config).odds[area.areaId] })) };
  }

  buildConf(table) {
    return engine.baccaratConf(table);
  }

  enterSnapshot(table, session) {
    return engine.enterSnapshot(table, session);
  }

  onCycle(ctx, cycle) {
    if (cycle === 0) {
      ctx.table.config = this.config;
      ctx.table.totalBetsByArea = engine.emptyAreas(this.config.odds);
    }
    return engine.applyCycle(ctx.io, ctx.table, cycle);
  }

  pushState(ctx) {
    const table = ctx.table;
    ctx.io.broadcast(PUSH.MB_SNC_ROOM_STATE, { ...this.enterSnapshot(table, { userId: 0, wallet: 0 }), customData: 2 });
    ctx.io.broadcast(PUSH.GAME_STATE, {
      roomType: table.roomType, roomId: table.roomId, countDown: Math.max(0, table.phaseEndsAt - Date.now()),
      state: table.state,
      inning: table.inning,
      supplyState: table.supplyState,
      remainCardsNum: table.remainCardsNum,
      cutIndex: table.cutIndex,
      collectCardCount: table.collectCardCount,
      dealCardCount: table.dealCardCount,
      dealRealCount: table.dealRealCount,
    });
  }
}

export default new BaccaratGame();
