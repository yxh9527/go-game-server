import { rel } from '../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { BairenGame } = await rel(import.meta.url, './BairenGame.js', v);
const { engine } = await rel(import.meta.url, './turntable-engine.js', v);
const { roomRules } = await rel(import.meta.url, './turntable-rules.js', v);

// The five original arcade modules differ only in identity, wheel layout and odds.
// Betting, wallet retry, subscriptions, history and robots remain in public core.
export class TurntableGame extends BairenGame {
  constructor(config) { super(config, engine, roomRules); }
  extraTableFields(row) {
    const fields = super.extraTableFields(row);
    return { ...fields, defaultOuter: fields.rules.defaultOuter.slice(),
      defaultInner: fields.rules.defaultInner.slice(), outerIndex: 0, innerIndex: 0,
      consecutiveWinCounts: {} };
  }
  buildConf(table) {
    const conf = super.buildConf(table);
    return { ...conf, hundredSwitch: true, [table.rules.key + 'Params']: conf.hundredParams };
  }
  onMessage(ctx, id, body = {}) {
    if (id === 6107) {
      ctx.send(6207, { roomType: ctx.table.roomType, roomId: ctx.table.roomId, playerNum: ctx.table.people });
      return true;
    }
    if (id === 6111) return this.engine.cancelBets(ctx, body);
    return super.onMessage(ctx, id, body);
  }
  tick(ctx) {
    if (!ctx.table.hand) {
      const row = ctx.runtime?.configs?.find(row => Number(row.game_room_config_id) === Number(ctx.table.rules.gameRoomConfigId)
        && Number(row.room_type) === Number(ctx.table.roomType));
      const rules = this.rulesForRoom(row || ctx.table.cfg, this.config);
      ctx.table.rules = rules;
      ctx.table.defaultOuter = rules.defaultOuter.slice();
      ctx.table.defaultInner = rules.defaultInner.slice();
    }
    return super.tick(ctx);
  }
}
