import { createHash } from 'node:crypto';

export function createSessionControl(runtime, { send, close, kickId }) {
  const state = runtime.sessionControl ||= { sequence: 0, latest: new Map(), queues: new Map(), sockets: new WeakMap() };
  const accountKey = s => `${Number(s.agentId) || 0}:${Number(s.userId)}`;
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
  async function evict(entries) {
    // Revoke the whole old group before waiting for any asynchronous refund.
    for (const [ws, session] of entries) {
      const alreadyRevoked = session.superseded;
      session.superseded = true;
      session.authenticated = false;
      if (!alreadyRevoked) {
        send(ws, kickId);
        ws.close?.(1000, 'Replaced by a new login');
      }
    }
    await Promise.all(entries.map(([ws]) => close(ws)));
  }
  function peers(session, ws) {
    return [...runtime.registry.sessions].filter(([other, s]) => other !== ws
      && accountKey(s) === accountKey(session) && (s.authenticated !== false || s.superseded));
  }
  return {
    socketState,
    begin(ws, action) {
      const socket = socketState(ws);
      if (socket.closed) return Promise.resolve();
      if (socket.loginTask) return socket.loginTask;
      const order = ++state.sequence;
      const task = Promise.resolve().then(() => action(order));
      socket.loginTask = task;
      const clear = () => { if (socket.loginTask === task) delete socket.loginTask; };
      task.then(clear, clear);
      return task;
    },
    identity(body) {
      // The native primary and hundred sockets send the same credential/device.
      return createHash('sha256').update(JSON.stringify([String(body.userToken || body.token || ''),
        String(body.deviceId || '')])).digest('hex');
    },
    accept(ws, session, order) {
      return serialize(accountKey(session), async () => {
        const socket = socketState(ws), key = accountKey(session);
        if (socket.closed || ws.readyState !== 1) return false;
        if ((state.latest.get(key) || 0) > order) {
          socket.closed = true;
          send(ws, kickId);
          ws.close?.(1000, 'Replaced by a new login');
          return false;
        }
        state.latest.set(key, order);
        const existing = peers(session, ws);
        const primary = existing.length === 1 && existing[0][1];
        const host = primary && runtime.registry.getTable(primary.roomId, primary.agentId, primary.gameId);
        const paired = primary && !primary.superseded && primary.loginRole !== 'hundred' && host?.kind === 'normal'
          && [19, 25, 24, 31, 26].includes(Number(host.roomType)) && primary.inRoom === true
          && primary.loginIdentity === session.loginIdentity && Number(primary.roomId) === Number(session.roomId);
        session.loginRole = paired ? 'hundred' : 'primary';
        session.loginGroup = paired ? primary.loginGroup : order;
        if (!paired) await evict(existing);
        if (socket.closed || ws.readyState !== 1) return false;
        runtime.registry.bind(ws, session);
        return true;
      });
    },
    // 1105 has no channel field. A compatible second socket is provisional:
    // if it sends a normal join, it is a new primary and replaces the old pair.
    async promote(ws, session) {
      if (session.loginRole !== 'hundred') return;
      if (session.superseded) return;
      session.loginRole = 'primary';
      await evict(peers(session, ws));
    },
  };
}
