import { createHash, randomUUID } from 'node:crypto';

export function createSessionControl(runtime, { send, close, kickId }) {
  const state = runtime.sessionControl ||= { sequence: 0, latest: new Map(), queues: new Map(), sockets: new WeakMap() };
  state.pendingLogins ||= new Map();
  if(!state.latestKeysByUser){
    state.latestKeysByUser=new Map();
    for(const key of state.latest.keys()){
      const uid=Number(key.slice(key.lastIndexOf(':')+1)),keys=state.latestKeysByUser.get(uid)||new Set();
      keys.add(key);state.latestKeysByUser.set(uid,keys);
    }
  }
  const distributed=runtime.bus?.gameSessions||null;
  state.instanceId ||= distributed?.instanceId || randomUUID();
  const accountKey = s => `${Number(s.agentId) || 0}:${Number(s.userId)}`;
  function pruneLatest(userId){
    const uid=Number(userId);if(!uid)return;
    if([...state.pendingLogins.values()].some(id=>id===uid)
      ||[...runtime.registry.sessions.values()].some(s=>Number(s.userId)===uid))return;
    for(const key of state.latestKeysByUser.get(uid)||[])state.latest.delete(key);
    state.latestKeysByUser.delete(uid);
  }
  function socketState(ws) {
    if (!state.sockets.has(ws)) state.sockets.set(ws, {});
    return state.sockets.get(ws);
  }
  function serialize(key, action) {
    const before = state.queues.get(key) || Promise.resolve();
    const task = before.catch(() => {}).then(action);
    state.queues.set(key, task);
    const clear = () => { if (state.queues.get(key) === task) state.queues.delete(key); };
    task.then(clear, clear);
    return task;
  }
  async function evict(entries,reason='replaced') {
    // Revoke the whole old group before waiting for any asynchronous refund.
    for (const [ws, session] of entries) {
      const alreadyRevoked = session.superseded;
      session.superseded = true;
      session.authenticated = false;
      if (!alreadyRevoked) {
        const auxiliaryClosed=reason==='primary-closed'&&session.loginRole==='hundred';
        send(ws,kickId,auxiliaryClosed?{reason:'primary-closed',auxiliary:true}:undefined);
        const disconnect = () => ws.close?.(1000,auxiliaryClosed?'Primary connection closed':'Replaced by a new login');
        if (runtime.wallet?.deliver) runtime.wallet.deliver(disconnect); else disconnect();
      }
    }
    await Promise.all(entries.map(([ws]) => close(ws)));
  }
  function revokeLogin(loginId,reason='replaced'){
    if(!loginId)return;
    const entries=[...runtime.registry.sessions].filter(([,session])=>session.loginId===loginId);
    if(entries.length)void evict(entries,reason).catch(error=>runtime.log?.error?.('distributed session eviction failed',error.message));
    runtime.log?.info?.(`[game-server] session revoked login=${loginId} reason=${reason}`);
  }
  state.revokeLogin=revokeLogin;
  if(distributed&&state.distributed!==distributed){
    state.unsubscribe?.();state.distributed=distributed;
    state.unsubscribe=distributed.subscribe(message=>{
      try{const event=typeof message==='string'?JSON.parse(message):message;if(event?.event==='revoke')state.revokeLogin(event.loginId,event.reason);}
      catch(error){runtime.log?.error?.('invalid distributed session event',error.message);}
    });
  }
  function peers(session, ws) {
    return [...runtime.registry.sessions].filter(([other, s]) => other !== ws
      && accountKey(s) === accountKey(session) && (s.authenticated !== false || s.superseded));
  }
  function retireAuxiliary(ws,socket){
    socket.closed=true;send(ws,kickId,{reason:'primary-closed',auxiliary:true});
    const disconnect=()=>ws.close?.(1000,'Primary connection unavailable');
    if(runtime.wallet?.deliver)runtime.wallet.deliver(disconnect);else disconnect();
    return false;
  }
  return {
    socketState,
    beginAttempt(userId){return distributed?distributed.beginAttempt(userId):Promise.resolve(++state.sequence);},
    begin(ws, action, userId=0) {
      const socket = socketState(ws);
      if (socket.closed) return Promise.resolve();
      if (socket.loginTask) return socket.loginTask;
      const order = ++state.sequence;
      state.pendingLogins.set(order,Number(userId)||0);
      const task = Promise.resolve().then(() => action(order));
      socket.loginTask = task;
      const clear = () => {
        if (socket.loginTask === task) delete socket.loginTask;
        const uid=state.pendingLogins.get(order);state.pendingLogins.delete(order);pruneLatest(uid);
      };
      task.then(clear, clear);
      return task;
    },
    identity(body) {
      // The native primary and hundred sockets send the same credential/device.
      return createHash('sha256').update(JSON.stringify([String(body.userToken || body.token || ''),
        String(body.deviceId || '')])).digest('hex');
    },
    accept(ws, session, order, credentials = {}) {
      return serialize(accountKey(session), async () => {
        const socket = socketState(ws), key = accountKey(session);
        if (socket.closed || ws.readyState !== 1) return false;
        if ((state.latest.get(key) || 0) > order) {
          if(credentials.auxiliaryOnly===true)return retireAuxiliary(ws,socket);
          socket.closed = true;
          send(ws, kickId);
          const disconnect = () => ws.close?.(1000, 'Replaced by a new login');
          if (runtime.wallet?.deliver) runtime.wallet.deliver(disconnect); else disconnect();
          return false;
        }
        let lease=null;
        if(distributed){
          // 1105 carries neither socket channel nor gameId. The native client
          // opens RoomSocket-222 even while openHundredGame is false.
          lease=await distributed.claim(session,{identity:session.loginIdentity,allowPair:true,requirePair:credentials.auxiliaryOnly===true,attempt:session.loginAttempt});
          if(lease?.auxiliaryAbsent)return retireAuxiliary(ws,socket);
          if(!lease?.ok)throw Object.assign(new Error('Game session claim failed'),{code:'SESSION_CLAIM_FAILED'});
          session.loginId=lease.loginId;session.sessionGeneration=lease.generation;session.loginRole=lease.role;
          if(socket.closed||ws.readyState!==1){await distributed.release(session);return false;}
        }
        const existing = peers(session, ws);
        const primary = existing.length === 1 && existing[0][1];
        const host = primary && runtime.registry.getTable(primary.roomId, primary.agentId, primary.gameId);
        const normalTypes=[19,24,25,26,27,28,30,31,32];
        const hostType=Number(host?.roomType||primary?.roomType);
        const localPaired = primary && !primary.superseded && primary.loginRole !== 'hundred'
          && (credentials.auxiliaryOnly===true?hostType>0&&hostType!==101:normalTypes.includes(hostType))
          && (primary.inRoom===true||credentials.auxiliaryOnly===true&&primary.hasJoined===false)
          && primary.loginIdentity === session.loginIdentity && Number(primary.roomId) === Number(session.roomId);
        const paired=lease?lease.role==='hundred':localPaired;
        if(credentials.auxiliaryOnly===true&&!paired)return retireAuxiliary(ws,socket);
        state.latest.set(key, order);
        const uid=Number(session.userId),keys=state.latestKeysByUser.get(uid)||new Set();
        keys.add(key);state.latestKeysByUser.set(uid,keys);
        session.loginRole = paired ? 'hundred' : 'primary';
        session.loginGroup = paired ? (lease?.loginId||primary.loginGroup) : (lease?.loginId||order);
        if (!paired) {
          try{await evict(existing);}
          catch(error){if(lease)await distributed.release(session);throw error;}
        }
        if (socket.closed || ws.readyState !== 1) {
          if(lease)await distributed.release(session);
          return false;
        }
        runtime.registry.bind(ws, session);
        return true;
      });
    },
    // 1105 has no channel field. A compatible second socket is provisional:
    // if it sends a normal join, it is a new primary and replaces the old pair.
    async promote(ws, session) {
      if (session.loginRole !== 'hundred') return;
      if (session.superseded) return;
      if(distributed){
        const oldLoginId=session.loginId;session.loginId=randomUUID();
        try{
          const lease=await distributed.claim(session,{identity:session.loginIdentity,allowPair:false,attempt:await this.beginAttempt(session.userId)});
          if(!lease?.ok)throw Object.assign(new Error('Game session promotion failed'),{code:'SESSION_CLAIM_FAILED'});
          session.loginId=lease.loginId;session.sessionGeneration=lease.generation;
          session.loginRole='primary';session.loginGroup=lease.loginId;
        }catch(error){session.loginId=oldLoginId;throw error;}
        return;
      }
      session.loginRole = 'primary';
      await evict(peers(session, ws));
    },
    async verify(ws,session){
      if(!distributed||!session?.loginId)return true;
      const valid=await distributed.verify(session);
      if(!valid){session.superseded=true;session.authenticated=false;send(ws,kickId);try{ws.close?.(1000,'Game session replaced');}catch{}}
      return valid;
    },
    async withSession(ws,action){
      const session=runtime.registry.session(ws);
      if(!distributed||!session||session.authenticated===false||!session.loginId)return action();
      return distributed.withSession(session,async()=>{
        if(session.superseded)return false;
        return action();
      });
    },
    serialize(ws,action){
      const session=runtime.registry.session(ws);
      return !distributed||!session?action():distributed.serialize(session,action);
    },
    async renewAll(){
      if(!distributed)return;
      const current=[...runtime.registry.sessions].filter(([,session])=>session.authenticated!==false&&!session.superseded);
      const results=await Promise.allSettled(current.map(([,session])=>distributed.renew(session)));
      for(let i=0;i<results.length;i++)if(results[i].status==='fulfilled'&&!results[i].value){
        const session=current[i][1];revokeLogin(session.loginId,'lease-lost');
      }
      const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    },
    updateRoom(session,table){return !distributed||session.loginRole==='hundred'?Promise.resolve(true):distributed.updateRoom(session,table);},
    async release(session){
      try{return distributed&&session?.loginId?await distributed.release(session):false;}
      finally{pruneLatest(session?.userId);}
    },
  };
}
