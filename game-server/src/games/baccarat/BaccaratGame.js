import { HundredGame } from "../../core/HundredGame.js";
import { PUSH } from "../../messages.js";
import config from "./config.js";
import * as engine from "./engine.js";

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

  buildConf(table) {
    return engine.baccaratConf(table);
  }

  enterSnapshot(table, session) {
    return engine.enterSnapshot(table, session);
  }

  onCycle(ctx, cycle) {
    engine.applyCycle(ctx.io, ctx.table, cycle);
  }

  pushState(ctx) {
    const table = ctx.table;
    ctx.io.broadcast(PUSH.GAME_STATE, {
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
