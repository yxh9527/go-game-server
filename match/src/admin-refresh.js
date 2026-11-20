// Only two current read tickets are retained: foreground and background.
// Navigation invalidates their UI ownership; it never retries a mutation.
export function createAdminRefresh({view,scope,assertScope,stale}){
  let epoch=0,sequence=0,foreground=null,background=null;
  function begin(kind){
    const identity=scope();
    if(kind==='background'&&(foreground||background))return null;
    const ticket={epoch,sequence:++sequence,view:view(),scope:identity,kind};
    if(kind==='foreground'){foreground=ticket;background=null;}else background=ticket;
    return ticket;
  }
  return {
    foreground:()=>begin('foreground'),background:()=>begin('background'),
    assertCurrent(ticket){
      assertScope(ticket.scope);
      if(ticket.epoch!==epoch||ticket.sequence!==sequence||ticket.view!==view()||(ticket.kind==='foreground'?foreground:background)!==ticket)throw stale();
    },
    finish(ticket){if(foreground===ticket)foreground=null;if(background===ticket)background=null;},
    invalidate(){epoch++;foreground=null;background=null;},
    stats(){return {foregroundReads:foreground?1:0,backgroundReads:background?1:0};},
  };
}
