import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { default: game } = await rel(import.meta.url, './HundredBlackjackGame.js', v);
export default game;
