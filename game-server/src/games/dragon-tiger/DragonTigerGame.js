import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { CardShoeGame } = await rel(import.meta.url, '../../core/CardShoeGame.js', v);
const { default: config } = await rel(import.meta.url, './config.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
const history = await rel(import.meta.url, '../../core/hundred-card-history.js', v);

export class DragonTigerGame extends CardShoeGame {
  constructor() { super(config, engine, history); }
  extraTableFields(row) {
    return { ...super.extraTableFields(row), totalBetsByArea: engine.emptyAreas(this.config.odds, Number(row?.play_mode || 0)) };
  }
}
export default new DragonTigerGame();
