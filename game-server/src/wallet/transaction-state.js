// Preserve object identity: hands, members and pending payouts reference each
// other. Replacing them with JSON copies would break hot-reload recovery.
export function captureGameState(runtime, ignored = []) {
  const skip = new Set([runtime, runtime.wallet, ...ignored, ...runtime.registry.sessions.keys()]);
  const sessions = new Set(runtime.registry.sessions.values());
  const records = [], seen = new Set();
  function visit(value) {
    if (!value || typeof value !== 'object' || skip.has(value) || seen.has(value) || Object.isFrozen(value)) return;
    if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet || ArrayBuffer.isView(value)) return;
    seen.add(value);
    if (value instanceof Map) {
      const entries = [...value]; records.push(() => { value.clear(); for (const [k,v] of entries) value.set(k,v); });
      for (const [k,v] of entries) { visit(k); visit(v); }
    } else if (value instanceof Set) {
      const entries = [...value]; records.push(() => { value.clear(); for (const v of entries) value.add(v); });
      for (const v of entries) visit(v);
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) return;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      records.push(() => {
        // Distributed eviction can revoke an existing connection while an
        // unrelated financial request awaits its reply. Game rollback cannot
        // reinstate that session's permission to act.
        const superseded=sessions.has(value)&&value.superseded===true;
        const unauthenticated=sessions.has(value)&&descriptors.authenticated?.value===true&&value.authenticated===false;
        for (const key of Reflect.ownKeys(value)) if (!Object.hasOwn(descriptors,key) && Object.getOwnPropertyDescriptor(value,key).configurable) delete value[key];
        for (const key of Reflect.ownKeys(descriptors)) if (key !== 'length') Object.defineProperty(value,key,descriptors[key]);
        if (descriptors.length) Object.defineProperty(value,'length',descriptors.length);
        if(superseded)value.superseded=true;
        if(superseded||unauthenticated)value.authenticated=false;
      });
      for (const key of Reflect.ownKeys(descriptors)) if ('value' in descriptors[key]) visit(descriptors[key].value);
    }
  }
  visit(runtime.registry.tables); visit(runtime.registry.roomManager);
  // Session registry keys are sockets, intentionally excluded from traversal.
  visit(runtime.registry.sessions);
  let finished=false;
  const discard=()=>{
    finished=true;records.length=0;skip.clear();seen.clear();sessions.clear();
  };
  const restore=()=>{
    if(finished)return;
    try{for(let i=records.length-1;i>=0;i--)records[i]();}
    finally{discard();}
  };
  // A retained completion callback must not keep a completed transaction's
  // entire room graph alive, or roll it back again after later game actions.
  restore.discard=discard;
  return restore;
}
