import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { GglGame } = await rel(import.meta.url, '../ggl-core/GglGame.js', v);
const { default: config } = await rel(import.meta.url, './config.js', v);

export class GglMjhlGame extends GglGame {
  constructor() {
    super(config);
  }
}

export default new GglMjhlGame();
