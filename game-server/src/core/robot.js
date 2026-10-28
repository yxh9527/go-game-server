import { applyCredit, applyDebit } from "../wallet/WalletAdapter.js";
import { rel } from "../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { PUSH } = await rel(import.meta.url, "../messages.js", version);
const lifecycle = await rel(import.meta.url, "./room-lifecycle.js", version);

// Simulated bankrolls never use the human RPC wallet. The same SeatGame
// sit/carry/stand handlers still validate seats, amounts and record statistics.
const wallet = { debit: applyDebit, credit: applyCredit };
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const delay = (min, max, rng) => min + Math.floor(rng() * (max - min + 1));

// One policy for every SeatGame. Games provide their ordinary buy-in sizing;
// their robot.js contains only gameplay decisions, never another room loop.
export const roomBehavior = Object.freeze({
  joinProbability: 0.6, leaveProbability: 0.15,
  checkMinMs: 5000, checkMaxMs: 10000, minStayMs: 45000,
  cooldownMinMs: 15000, cooldownMaxMs: 45000,
  carryMinMs: 1000, carryMaxMs: 3000, observerLifetimeMs: 180000, walletBuyIns: 5,
});
const FIRST_UID = 90000001;

export function tickRoom(game, ctx, now = Date.now(), rng = Math.random) {
  const { table, io } = ctx;
  if (table.standby || Number(table.roomType) === 101 || table.admissionTask || table.roundAdmission
    || lifecycle.isExpired(table, now)) return;
  if (!lifecycle.syncActivity(table, now)) return;
  const overrides = { ...game.config.robotBehavior, ...table.cfg?.robot_behavior };
  const settings = { ...roomBehavior };
  for (const key of Object.keys(settings)) {
    if (typeof settings[key] === "number") settings[key] = finite(overrides[key], settings[key]);
  }
  for (const key of ["joinProbability", "leaveProbability"]) settings[key] = Math.max(0, Math.min(1, settings[key]));
  for (const [min, max] of [["checkMinMs", "checkMaxMs"], ["cooldownMinMs", "cooldownMaxMs"], ["carryMinMs", "carryMaxMs"]]) {
    settings[min] = Math.max(1000, settings[min]);
    settings[max] = Math.max(settings[min], settings[max]);
  }
  settings.carryMinMs = Math.min(settings.carryMinMs, 10000);
  settings.carryMaxMs = Math.min(settings.carryMaxMs, 10000);
  settings.minStayMs = Math.max(0, settings.minStayMs);
  settings.observerLifetimeMs = Math.max(1000, settings.observerLifetimeMs);
  settings.walletBuyIns = Math.max(1, Math.min(10, settings.walletBuyIns));
  const capacity = game.maxPeople(table);
  const limit = Math.max(0, Math.min(capacity - 1, Math.floor(finite(table.botTarget, capacity - 1))));
  const state = table.robotTraffic ||= {
    nextCheckAt: now + delay(settings.checkMinMs, settings.checkMaxMs, rng),
    nextUid: FIRST_UID, profiles: new Map(),
  };
  const cooldown = () => delay(settings.cooldownMinMs, settings.cooldownMaxMs, rng);
  const waitToRejoin = (profile) => {
    profile.wasSeated = false;
    profile.waitingAt = now;
    profile.canSitAt = now + cooldown();
    profile.carryAt = 0;
  };
  const seated = (uid) => table.members.find((member) => member.uid === uid);
  const observer = (uid) => table.observers.find((member) => member.uid === uid);
  const roomContext = (profile, body = {}) => ({
    ...ctx, session: profile.session, body, wallet, incrementalSeatUpdates: true,
    // ROOM_INFO invokes loginSuccess in the original client and interrupts a
    // live hand/settlement. Incremental JOIN/CARRY/STAND messages suffice.
    io: { ...io, broadcast: (id, payload) => {
      if (id === PUSH.ROOM_INFO) return;
      // The original carry-success handler only stops the countdown. JOIN
      // also refreshes an existing seat's point through the all-seat listener.
      if (id === PUSH.CARRY_SCORE_RESULT && payload.state === 0) {
        const member = seated(payload.uid);
        if (member) io.broadcast(PUSH.JOIN_ROOM, game.publicMember(member));
      }
      io.broadcast(id, payload);
    } },
    send: (id, payload) => { if (id === PUSH.JOIN_ROOM) io.broadcast(id, payload); },
  });
  // Adopt resident bots after hot update without resetting chips or minting a
  // new wallet. Observer point already represents carried-out simulated funds.
  for (const person of [...table.members, ...table.observers]) {
    if (!person.bot || state.profiles.has(person.uid)) continue;
    const inSeat = Boolean(seated(person.uid));
    state.profiles.set(person.uid, {
      session: { userId: person.uid, name: person.name, icon: person.icon, bot: true,
        wallet: inSeat ? 0 : Math.max(0, finite(person.point, 0)) },
      wasSeated: inSeat, seatedAt: now, waitingAt: now, canSitAt: now + cooldown(), carryAt: 0,
    });
  }
  for (const [uid, profile] of state.profiles) {
    const member = seated(uid);
    if (profile.wasSeated && !member) {
      waitToRejoin(profile);
    }
    if (!member && !observer(uid)) { state.profiles.delete(uid); continue; }
    if (member?.carryDeadline > 0) {
      if (now >= member.carryDeadline) {
        game.onStandUp(roomContext(profile));
        waitToRejoin(profile);
      }
      else if (profile.carryAt && now >= profile.carryAt) {
        game.onCarryScore(roomContext(profile, { carryIn: profile.buyIn / 100 }));
        profile.carryAt = 0;
      }
    }
  }
  const intervalDue = now >= state.nextCheckAt;
  if (intervalDue) state.nextCheckAt = now + delay(settings.checkMinMs, settings.checkMaxMs, rng);
  const betweenHands = table.phase !== "playing" && !table.hand;
  const animationEnded = !betweenHands || !(table.currentInning > 0 && now < table.startAt);
  const handEnded = table.currentInning > (state.lastLeaveInning || 0);
  // Each bot decides independently; never fold a live hand just to rotate the
  // table. A completed hand has its own opportunity, even when the periodic
  // timer falls inside an active hand or its settlement animation.
  if (betweenHands && animationEnded && (intervalDue || handEnded)) {
    state.lastLeaveInning = table.currentInning;
    for (const [uid, profile] of state.profiles) {
      const member = seated(uid);
      if (!member || member.carryDeadline > 0 || now - profile.seatedAt < settings.minStayMs) continue;
      if (rng() >= settings.leaveProbability) continue;
      game.onStandUp(roomContext(profile));
      waitToRejoin(profile);
    }
  }
  if (!intervalDue) return;
  for (const [uid, profile] of state.profiles) {
    if (seated(uid) || now - profile.waitingAt < settings.observerLifetimeMs) continue;
    game.onLeave(roomContext(profile));
    state.profiles.delete(uid);
  }
  // Full-table games must be able to start once a human occupies the reserved
  // seat. Other games, and observer-only full-table rooms, keep a free chair.
  const reserve = game.minPeople(table) === capacity && table.members.some(member => !member.bot) ? 0 : 1;
  if (table.members.length >= capacity - reserve
    || table.members.filter((member) => member.bot).length >= limit
    || !animationEnded || rng() >= settings.joinProbability) return;
  let profile = [...state.profiles.values()].find((item) => !seated(item.session.userId)
    && now >= item.canSitAt && item.session.wallet >= Math.max(1, finite(table.carryMin, 0)));
  if (!profile) {
    if (state.profiles.size >= capacity * 2) return;
    const used = new Set([...table.members, ...table.observers].map((member) => member.uid));
    const history = table.roomFeatures?.players;
    while (used.has(state.nextUid) || history?.has(state.nextUid)) state.nextUid += 1;
    const uid = state.nextUid++;
    const opening = Math.ceil(Math.max(1, finite(table.carryMin, 0), game.defaultBuyIn(table)));
    profile = { session: { userId: uid, name: "Bot" + (uid - FIRST_UID + 1), bot: true,
      wallet: Math.round(opening * settings.walletBuyIns) },
    wasSeated: false, waitingAt: now, canSitAt: now, seatedAt: now, carryAt: 0 };
    state.profiles.set(uid, profile);
    game.watch(table, profile.session);
  }
  const positions = new Set(table.members.map((member) => member.pos));
  const free = Array.from({ length: capacity }, (_, pos) => pos).filter((pos) => !positions.has(pos));
  const position = free[Math.floor(rng() * free.length)];
  game.onSitDown(roomContext(profile, { position }));
  const member = seated(profile.session.userId);
  if (member) {
    profile.wasSeated = true;
    profile.seatedAt = now;
    profile.buyIn = Math.min(profile.session.wallet, Math.ceil(Math.max(table.carryMin || 1, game.defaultBuyIn(table))));
    profile.carryAt = now + delay(settings.carryMinMs, settings.carryMaxMs, rng);
  }
}
