import { createHash } from 'node:crypto';

export const TOURNAMENT_DEDUP_TTL_MS = 60 * 60 * 1000;
export const TOURNAMENT_DEDUP_SWEEP_MS = 60 * 1000;

export function tournamentRequestKey(payload) {
  const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return [payload.agentId,payload.matchId,payload.action||payload.operation,digest].join(':');
}

// Only completed request responses expire. Financial journals and occurrence
// identities remain the authority after this disposable cache has been evicted.
export function createTournamentIdempotency(runtime) {
  const state=runtime.tournamentIdempotency ||= {entries:new Map(),pending:new Map()};
  const now=()=>runtime.clock?.()??Date.now();
  function sweep() {
    const at=now();
    for(const [key,entry] of state.entries)if(entry.expiresAt<=at)state.entries.delete(key);
  }
  state.sweep=sweep;
  if(!state.timer){
    state.timer=setInterval(()=>state.sweep(),TOURNAMENT_DEDUP_SWEEP_MS);
    state.timer.unref?.();
  }
  sweep();
  async function run(key,work) {
    const old=state.entries.get(key);
    if(old&&old.expiresAt>now())return structuredClone(old.value);
    if(old)state.entries.delete(key);
    if(state.pending.has(key))return structuredClone(await state.pending.get(key));
    const task=Promise.resolve().then(work).then(value=>{
      state.entries.set(key,{value:structuredClone(value),expiresAt:now()+TOURNAMENT_DEDUP_TTL_MS});
      return value;
    });
    state.pending.set(key,task);
    try{return structuredClone(await task);}
    finally{if(state.pending.get(key)===task)state.pending.delete(key);}
  }
  return {run,sweep};
}
