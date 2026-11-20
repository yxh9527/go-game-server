import fs from 'node:fs';

// A resident transport helper: callbacks own only the runtime's projection
// state and logger, never a business module namespace or its import closure.
let generation=0;
export const nextProjectionGeneration=()=>++generation;
export function ensureProjectionWatch(directory,state,log){
  if(state.watchFormat!==2){
    state.watcher?.close();state.watcher=null;state.watchFormat=2;
  }
  if(state.watcher)return;
  const changed=()=>{state.change=(state.change||0)+1;state.dirty=true;};
  const watcher=fs.watch(directory,(_event,file)=>{
    if(file==null||String(file)==='user-center.js')changed();
  });
  watcher.on('error',error=>{
    if(state.watcher===watcher){state.watcher=null;changed();}
    watcher.close();
    log?.error?.('user-center projection watcher failed',error.message);
  });
  watcher.unref();state.watcher=watcher;
}
