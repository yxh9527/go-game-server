// Both native multi-bet panels share one socket, but own separate customData contexts.
// Keep the selected single table independent from those cross-game subscriptions.
export function configuredHundredRooms(runtime, game, session) {
  return (runtime.configs || []).filter(row => Number(row.state ?? 1) === 1
    && game.roomTypes.includes(Number(row.room_type))).map(row => {
    const id = Number(row.game_room_config_id) * 10000 + Number(row.room_index || 0);
    let table = runtime.registry.getTable(id, session.agentId, game.id);
    if (!table) {
      table = game.createTable(id, Number(row.room_type), row);
      runtime.registry.setTable(id, table, session.agentId, game.id);
    }
    return table;
  });
}

export function createHundredSubscriptions(runtime, gameOf, ioFor) {
  const selected = (s, t) => s.hundredInRoom === true && s.hundredGameId === t.gameId
    && Number(s.hundredRoomId) === Number(t.roomId);
  function entries(session) {
    if (!session.hundredSubscriptions) {
      session.hundredSubscriptions = new Map();
      for (const id of session.hundredRoomIds || []) {
        const table = runtime.registry.getTable(id, session.agentId, session.hundredGameId);
        if (table) session.hundredSubscriptions.set(Number(id), { gameId: table.gameId,
          roomId: Number(id), contexts: new Set(selected(session, table) ? [] : [2]) });
      }
    }
    return session.hundredSubscriptions;
  }
  function tableFor(session, entry) {
    return runtime.registry.getTable(entry.roomId, session.agentId, entry.gameId);
  }
  function reconcile(session, oldIds) {
    const subscriptions = entries(session);
    for (const [id, entry] of subscriptions) {
      const table = tableFor(session, entry);
      if (!table || (!entry.contexts.size && !selected(session, table))) subscriptions.delete(id);
    }
    const current = session.hundredInRoom === true
      ? runtime.registry.getTable(session.hundredRoomId, session.agentId, session.hundredGameId) : null;
    if (current && !subscriptions.has(Number(current.roomId))) subscriptions.set(Number(current.roomId),
      { gameId: current.gameId, roomId: Number(current.roomId), contexts: new Set() });
    session.hundredRoomIds = new Set(subscriptions.keys());
    for (const [id, previous] of oldIds) {
      if (subscriptions.has(id)) continue;
      const table = tableFor(session, previous);
      if (!table) continue;
      gameOf(table.roomType).onLeave({ runtime, table, session, io: ioFor(table) });
      ioFor(table).broadcast(6207, { roomType: table.roomType, roomId: id, playerNum: table.people });
    }
    for (const [id, entry] of subscriptions) {
      const table = tableFor(session, entry);
      const added = !table.visitors?.has(Number(session.userId));
      gameOf(table.roomType).enter(table, session);
      if (added) ioFor(table).broadcast(6207, { roomType: table.roomType, roomId: id, playerNum: table.people });
    }
  }
  function rooms(session, request) {
    const game = gameOf(Number(request.roomType));
    if (!game || game.kind !== 'hundred') return [];
    const ids = Array.isArray(request.roomIds) ? new Set(request.roomIds.map(Number)) : null;
    return configuredHundredRooms(runtime, game, session).filter(t => !ids || ids.has(Number(t.roomId)));
  }
  return {
    rooms,
    select(session, table) {
      const before = new Map(entries(session));
      session.hundredRoomId = table.roomId; session.hundredGameId = table.gameId; session.hundredInRoom = true;
      reconcile(session, before);
    },
    register(session, body = {}) {
      const context = Number(body.customData) || 0;
      const requests = Array.isArray(body.mulRoomTypeList) ? body.mulRoomTypeList
        : body.roomType != null ? [{ roomType: body.roomType, ...(Array.isArray(body.roomIds) ? { roomIds: body.roomIds } : {}) }] : [];
      const targets = [...new Map(requests.flatMap(r => rooms(session, r)).map(t => [Number(t.roomId), t])).values()];
      const subscriptions = entries(session), before = new Map(subscriptions);
      for (const entry of subscriptions.values()) entry.contexts.delete(context);
      for (const table of targets) {
        const id = Number(table.roomId);
        if (!subscriptions.has(id)) subscriptions.set(id, { roomId: id, gameId: table.gameId, contexts: new Set() });
        subscriptions.get(id).contexts.add(context);
        subscriptions.get(id).lastContext = context;
      }
      reconcile(session, before);
      return targets;
    },
    unregister(session, body = {}) {
      const subscriptions = entries(session), before = new Map(subscriptions);
      const types = body.mulRoomTypeList?.map(r => Number(r.roomType))
        || (body.roomType != null ? [Number(body.roomType)] : []);
      for (const entry of subscriptions.values()) {
        const table = tableFor(session, entry);
        if (!table || types.length && !types.includes(Number(table.roomType))) continue;
        if (body.customData == null) entry.contexts.clear();
        else entry.contexts.delete(Number(body.customData) || 0);
      }
      reconcile(session, before);
    },
    leave(session) {
      const before = new Map(entries(session));
      session.hundredInRoom = false;
      session.hundredSubscriptions.clear();
      reconcile(session, before);
    },
    target(session, roomId, roomType) {
      const entry = entries(session).get(Number(roomId));
      const table = entry && tableFor(session, entry);
      return table && (roomType == null || Number(roomType) === Number(table.roomType)) ? table : null;
    },
    context(session, table) {
      const entry = entries(session).get(Number(table.roomId));
      return entry?.contexts.has(entry.lastContext) ? entry.lastContext : [...(entry?.contexts || [])][0] ?? 2;
    },
  };
}

export function hundredContexts(session, table) {
  const entry = session.hundredSubscriptions?.get(Number(table.roomId));
  if (entry?.gameId === table.gameId) return [...entry.contexts];
  return session.hundredRoomIds?.has(Number(table.roomId)) ? [2] : [];
}
