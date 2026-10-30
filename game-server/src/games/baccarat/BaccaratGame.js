import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { CardShoeGame } = await rel(import.meta.url, '../../core/CardShoeGame.js', v);
const { default: config } = await rel(import.meta.url, './config.js', v);
const engine = await rel(import.meta.url, './engine.js', v);
const history = await rel(import.meta.url, './history.js', v);
export class BaccaratGame extends CardShoeGame { constructor() { super(config, engine, history); } }
export default new BaccaratGame();
