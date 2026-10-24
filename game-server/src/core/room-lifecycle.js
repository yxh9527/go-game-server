// Cash-table capacity and lifetime policy. State belongs to the persistent room,
// so a business-module reload cannot restart its clock.
export const ROOM_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ROOM_LIFETIME_SECONDS = ROOM_LIFETIME_MS / 1000;
export const OCCUPANCY_THRESHOLD = 0.8;
export const EXPANSION_RATIO = 0.05;

export function initializeLifetime(table, now = Date.now()) {
  if (!Number.isFinite(table.createdAt)) {
    table.createdAt = Number.isFinite(table.roomFeatures?.startedAt) ? table.roomFeatures.startedAt : now;
  }
  table.expiresAt = table.createdAt + ROOM_LIFETIME_MS;
  // Remove the former last-human-left policy when adopting an existing table.
  delete table.retireWhenHandEnds;
  if (!table.closing) delete table.retired;
  return table;
}

export function isExpired(table, now = Date.now()) {
  initializeLifetime(table, now);
  return table.closing === true || now >= table.expiresAt;
}

export function remainingSeconds(table, now = Date.now()) {
  initializeLifetime(table, now);
  return Math.max(0, Math.ceil((table.expiresAt - now) / 1000));
}

export function capacityGroupKey(table) {
  return JSON.stringify([Number(table.agentId) || 0, table.gameId, Number(table.roomType),
    Number(table.cfg?.game_room_config_id) || Math.floor(Number(table.roomId) / 10000),
    Number(table.playMode ?? table.cfg?.play_mode) || 0]);
}

export function capacitySnapshot(tables, capacityOf) {
  let seats = 0;
  let occupied = 0;
  let fullRooms = 0;
  for (const table of tables) {
    const capacity = Math.max(0, Math.floor(Number(capacityOf(table)) || 0));
    seats += capacity;
    const positions = new Set((table.members || []).filter((member) =>
      Number.isInteger(member.pos) && member.pos >= 0 && member.pos < capacity).map((member) => member.pos));
    occupied += positions.size;
    if (capacity > 0 && positions.size === capacity) fullRooms += 1;
  }
  return { rooms: tables.length, fullRooms, seats, occupied,
    occupancy: tables.length ? fullRooms / tables.length : 0 };
}

export function expansionCount(tables, capacityOf) {
  const stats = capacitySnapshot(tables, capacityOf);
  return stats.rooms > 0 && stats.fullRooms * 100 >= stats.rooms * 80
    ? Math.max(1, Math.ceil(stats.rooms * EXPANSION_RATIO)) : 0;
}

export function prepareClosure(table, now = Date.now()) {
  if (table.closure) return table.closure;
  if (table.phase === "playing" && table.hand) throw new Error("An active hand must settle before room closure");
  const payouts = new Map();
  const add = (member, value) => {
    if (member.bot) return;
    const uid = Number(member.uid);
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid room closure balance");
    if (!payouts.has(uid)) payouts.set(uid, { uid, amount: 0, credited: false, persisted: false });
    payouts.get(uid).amount += amount;
  };
  for (const member of table.members || []) add(member, member.point ?? 0);
  table.closing = true;
  table.phase = "closed";
  table.startAt = 0;
  table.closure = { closedAt: now, payouts };
  return table.closure;
}
