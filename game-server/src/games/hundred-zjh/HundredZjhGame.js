import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { BairenGame } = await rel(import.meta.url, '../../core/BairenGame.js', v);
const { default: config, roomRules } = await rel(import.meta.url, './config.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
export class HundredZjhGame extends BairenGame {
  constructor() { super(config, engine, roomRules); }
}
export default new HundredZjhGame();
