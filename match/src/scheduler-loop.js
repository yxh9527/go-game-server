// Resident timer callback owns only the loop and logger. Replacing business
// code updates loop.work without retaining the first application's closure.
export function ensureTournamentScheduler(loop,log){
  if(loop.timerFormat!==1){
    if(loop.timer)clearInterval(loop.timer);
    loop.timer=null;loop.timerFormat=1;
  }
  if(!loop.timer){
    loop.timer=setInterval(async()=>{
      if(loop.busy)return;
      loop.busy=true;
      try{await loop.work();}
      catch(error){try{log?.error?.('tournament scheduler failed',error.message);}catch{}}
      finally{loop.busy=false;}
    },1000);
    loop.timer.unref?.();
  }
}
