import { rel } from '../rel.js';
import { env } from '../../../shared/rpc/env.js';
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const local = env.isDev ? await rel(import.meta.url, '../../../cache/game-server/hundred-history.js', v) : null;
const {queryHundredHistory}=await rel(import.meta.url,'./game-history.js',v);

export function record(table, result, viewers, io = {}) {
  if (io.env === 'prod') return;
  const extras = new Map();
  for (const [uid, data] of result.bankerSettlements || []) extras.set(uid, {
    bankerInningData: { bankerTotalWinLoseMap: result.bankerTotalWinLoseMap,
      bankerAreaTotalBet: { 1: data.normalTotalBet, 2: data.specialTotalBet },
      bankerInningInfoMap: { [uid]: { dataMap: Object.fromEntries(data.areas.map(a => [a.bankerType,
        { score: a.score, proportion: a.proportion }])) } } } });
  local?.record(table, { showdownPokers: result.showdownPokers || { other: result.player, banker: result.banker },
    showdownTypes: result.showdownTypes || { other: result.p, banker: result.b }, winAreaIds: result.areas.slice() }, viewers, result.settlements, extras);
}

export async function list(ctx){
 if(local&&ctx.runtime?.env!=='prod')return local.list(ctx.table,Number(ctx.session.userId));
 return queryHundredHistory(ctx);
}
export async function detail(ctx,inning){
 if(local&&ctx.runtime?.env!=='prod')return local.detail(ctx.table,Number(ctx.session.userId),inning);
 return queryHundredHistory(ctx,inning);
}
