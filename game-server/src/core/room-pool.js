import { rel } from "../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const lifecycle = await rel(import.meta.url, "./room-lifecycle.js", version);

export function createRoomPool(runtime, gameOf) {
  const registry = runtime.registry;
  // registry.js and the network listener stay resident during hot updates.
  const state = registry.roomPoolState ||= { nextIndexes: new Map() };
  const eligible = (table) => table.kind === "normal" && Number(table.roomType) !== 101;
  const capacityOf = (table) => gameOf(table.roomType)?.maxPeople?.() || 0;

  function track(table) {
    if (!eligible(table)) return;
    const cfgId = Number(table.cfg?.game_room_config_id) || Math.floor(table.roomId / 10000);
    const key = JSON.stringify([Number(table.agentId) || 0, table.gameId, cfgId]);
    const index = Number(table.roomId) - cfgId * 10000;
    if (index >= 0 && index < 10000) state.nextIndexes.set(key, Math.max(index + 1, state.nextIndexes.get(key) || 0));
  }
  for (const table of registry.tables.values()) track(table);

  function wasAllocated(roomId, roomType, agentId, cfg) {
    const game = gameOf(roomType);
    if (!game || game.kind !== "normal" || Number(roomType) === 101) return false;
    const cfgId = Number(cfg?.game_room_config_id) || Math.floor(Number(roomId) / 10000);
    const index = Number(roomId) - cfgId * 10000;
    const key = JSON.stringify([Number(agentId) || 0, game.id, cfgId]);
    return index >= 0 && index < (state.nextIndexes.get(key) || 0);
  }

  function active(now = Date.now()) {
    return [...registry.tables.values()].filter((table) => eligible(table) && !lifecycle.isExpired(table, now));
  }

  function create(roomId, roomType, agentId, cfg, standby = false, now = Date.now()) {
    const game = gameOf(roomType);
    if (!game || game.kind !== "normal" || Number(roomType) === 101) throw new Error("Unsupported room pool game");
    if (registry.getTable(roomId, agentId, game.id)) throw new Error("Room already exists");
    const table = game.createTable(roomId, roomType, cfg);
    table.createdAt = now;
    if (Number.isFinite(table.suspendedAt)) table.suspendedAt = now;
    lifecycle.initializeLifetime(table, now);
    if (table.roomFeatures) table.roomFeatures.startedAt = table.createdAt;
    table.agentId = Number(agentId) || 0;
    table.standby = standby;
    registry.setTable(roomId, table, agentId, game.id);
    track(table);
    return table;
  }

  function createNext(template, now = Date.now(), standby = true) {
    const cfgId = Number(template.cfg?.game_room_config_id) || Math.floor(template.roomId / 10000);
    if (!Number.isSafeInteger(cfgId) || cfgId <= 0) throw new Error("Invalid room configuration identity");
    const base = cfgId * 10000;
    const sequenceKey = JSON.stringify([Number(template.agentId) || 0, template.gameId, cfgId]);
    const occupied = registry.listAgentGameRooms(template.agentId, template.gameId);
    let index = state.nextIndexes.get(sequenceKey) ?? 0;
    for (const table of occupied) {
      const roomIndex = Number(table.roomId) - base;
      if (roomIndex >= 0 && roomIndex < 10000) index = Math.max(index, roomIndex + 1);
    }
    if (index >= 10000) throw new Error("Room indexes exhausted for this configuration");
    state.nextIndexes.set(sequenceKey, index + 1);
    return create(base + index, template.roomType, template.agentId,
      { ...template.cfg, game_room_config_id: cfgId, room_index: index }, standby, now);
  }

  function expand(now = Date.now()) {
    const groups = new Map();
    for (const table of active(now)) {
      const key = lifecycle.capacityGroupKey(table);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(table);
    }
    const created = [];
    for (const tables of groups.values()) {
      const count = lifecycle.expansionCount(tables, capacityOf);
      try {
        for (let n = 0; n < count; n += 1) created.push(createNext(tables[0], now, true));
      } catch (error) {
        // Reserve allocation must not interrupt player actions or settlement.
        runtime.log?.error?.("room reserve expansion failed", error.message);
      }
    }
    return created;
  }

  function allocate(agentId, cfg, requestedIndex, now = Date.now()) {
    const roomType = Number(cfg.room_type);
    const game = gameOf(roomType);
    const cfgId = Number(cfg.game_room_config_id);
    const index = Number(requestedIndex ?? cfg.room_index ?? 0);
    if (!Number.isInteger(index) || index < 0 || index >= 10000) throw new Error("Invalid room index");
    const playMode = game?.extraTableFields?.(cfg)?.playMode ?? cfg.play_mode;
    const template = { agentId, gameId: game?.id, roomType, playMode: Number(playMode) || 0,
      roomId: cfgId * 10000 + index, cfg };
    const key = lifecycle.capacityGroupKey(template);
    const candidates = active(now).filter((table) => lifecycle.capacityGroupKey(table) === key);
    const hasSeat = (table) => lifecycle.capacitySnapshot([table], capacityOf).occupied < capacityOf(table);
    let table = candidates.find((item) => item.roomId === template.roomId && hasSeat(item))
      || candidates.filter(hasSeat).sort((a, b) => (a.members?.length || 0) - (b.members?.length || 0) || a.roomId - b.roomId)[0];
    if (!table) {
      const sequenceKey = JSON.stringify([Number(agentId) || 0, game?.id, cfgId]);
      const canUseRequested = !state.nextIndexes.has(sequenceKey)
        && !registry.getTable(template.roomId, agentId, game?.id);
      table = canUseRequested ? create(template.roomId, roomType, agentId, { ...cfg, room_index: index }, true, now)
        : createNext(template, now, true);
      const next = table.roomId - cfgId * 10000 + 1;
      state.nextIndexes.set(sequenceKey, Math.max(next, state.nextIndexes.get(sequenceKey) || 0));
    }
    return describe(table, now);
  }

  function describe(table, now = Date.now()) {
    return {
      roomId: table.roomId, roomType: table.roomType,
      gameRoomConfigId: Number(table.cfg?.game_room_config_id) || Math.floor(table.roomId / 10000),
      roomIndex: table.roomId % 10000, playMode: Number(table.playMode) || 0,
      totalPeople: (table.members || []).length, maxPeople: capacityOf(table),
      createdAt: table.createdAt, expiresAt: table.expiresAt,
      leftTime: lifecycle.remainingSeconds(table, now),
    };
  }

  function list(agentId, now = Date.now()) {
    return active(now).filter((table) => Number(table.agentId || 0) === Number(agentId || 0)).map((table) => describe(table, now));
  }

  return { eligible, create, createNext, expand, allocate, list, describe, track, wasAllocated };
}
