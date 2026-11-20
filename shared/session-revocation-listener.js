// Resident transport callback forwards to the current business handler. It
// must not capture the first session controller or its runtime/handler graph.
export function ensureSessionRevocations(state,distributed,log){
  if(!distributed)return;
  if(state.distributed===distributed&&state.revocationListenerFormat===1)return;
  state.unsubscribe?.();
  state.distributed=distributed;
  state.revocationListenerFormat=1;
  state.unsubscribe=distributed.subscribe(message=>{
    try{
      const event=typeof message==='string'?JSON.parse(message):message;
      if(event?.event==='revoke')state.revokeLogin(event.loginId,event.reason);
    }catch(error){log?.error?.('invalid distributed session event',error.message);}
  });
}
