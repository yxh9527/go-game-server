import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { TurntableGame } = await rel(import.meta.url, '../../core/TurntableGame.js', v);
const { default: config } = await rel(import.meta.url, './config.js', v);
export default new TurntableGame(config);
