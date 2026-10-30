import { rel } from '../../game-server/src/rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const history = await rel(import.meta.url, './hundred-history.js', v);
export const { record, list, detail } = history;
