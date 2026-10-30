import { rel } from '../../rel.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
export const { REQUESTS, privilege, betAreas, snapshot, enter, canBet, afterBet, beforeRound, leave, handle } = await rel(import.meta.url, '../../core/hundred-table-owner.js', v);
