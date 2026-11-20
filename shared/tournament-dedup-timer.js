// Resident timer ownership is separate from replaceable request-cache logic.
// Its callback reads the current sweep method without retaining its creator.
export function ensureTournamentDedupTimer(state,interval){
  if(state.timerFormat!==1){
    if(state.timer)clearInterval(state.timer);
    state.timer=null;state.timerFormat=1;
  }
  if(!state.timer){
    state.timer=setInterval(()=>state.sweep(),interval);
    state.timer.unref?.();
  }
}
