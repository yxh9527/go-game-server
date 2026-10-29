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

// Hundred profiles, bankrolls and deadlines survive business hot reloads.
export const hundredBehavior = Object.freeze({
  enabled: true, initialRobots: 6, targetRobots: 10, maxRobots: 24,
  joinProbability: 0.7, leaveProbability: 0.12, participationProbability: 0.9,
  checkMinMs: 5000, checkMaxMs: 10000, minStayMs: 45000,
  cooldownMinMs: 15000, cooldownMaxMs: 45000,
  betMinMs: 1000, betMaxMs: 4000, maxBetsPerRound: 4, bankrollBets: 2000,
});

export function hundredWalletContext(ctx, session) {
  return session?.bot ? { ...ctx, wallet } : ctx;
}

export function hasPendingHundredBet(table, uid) {
  return Boolean(table.playerBets?.get(Number(uid))?.length)
    && table.hundredSettledInning !== table.inning;
}

function hundredSettings(game, table) {
  let room = table.cfg?.robot_behavior || {};
  if (typeof room === 'string') {
    try { room = JSON.parse(room); } catch { room = {}; }
  }
  const overrides = { ...game.config.hundredRobotBehavior, ...room };
  const settings = { ...hundredBehavior };
  for (const key of Object.keys(settings)) {
    if (typeof settings[key] === 'number') settings[key] = finite(overrides[key], settings[key]);
  }
  settings.enabled = overrides.enabled !== false && overrides.enabled !== 0;
  for (const key of ['joinProbability', 'leaveProbability', 'participationProbability']) {
    settings[key] = Math.max(0, Math.min(1, settings[key]));
  }
  settings.maxRobots = Math.max(0, Math.min(100, Math.floor(settings.maxRobots)));
  settings.targetRobots = Math.max(0, Math.min(settings.maxRobots, Math.floor(settings.targetRobots)));
  settings.initialRobots = Math.max(0, Math.min(settings.targetRobots, Math.floor(settings.initialRobots)));
  for (const [min, max] of [['checkMinMs', 'checkMaxMs'], ['cooldownMinMs', 'cooldownMaxMs'], ['betMinMs', 'betMaxMs']]) {
    settings[min] = Math.max(1000, settings[min]);
    settings[max] = Math.max(settings[min], settings[max]);
  }
  settings.minStayMs = Math.max(0, settings.minStayMs);
  settings.maxBetsPerRound = Math.max(1, Math.min(10, Math.floor(settings.maxBetsPerRound)));
  settings.bankrollBets = Math.max(1, Math.min(100000, Math.floor(settings.bankrollBets)));
  return settings;
}

// Only public legal areas, advertised odds and our own balance enter this view.
export function chooseHundredBet(view, rng = Math.random) {
  const { minBet, maxBet, balance, areas } = view;
  if (!Number.isSafeInteger(minBet) || minBet <= 0 || balance < minBet || !areas.length) return null;
  const weighted = areas.map(area => ({ ...area, weight: 1 / Math.max(1, Number(area.odds) || 1) }));
  let pick = rng() * weighted.reduce((sum, area) => sum + area.weight, 0);
  const chosen = weighted.find(area => (pick -= area.weight) < 0) || weighted.at(-1);
  const budget = Math.min(balance, maxBet, Math.max(minBet, Math.floor(balance * (0.002 + rng() * 0.013))));
  const chips = [1, 2, 5, 10, 20, 50, 100].map(n => n * minBet)
    .filter(n => Number.isSafeInteger(n) && n <= budget);
  if (!chips.length) return null;
  return { areaId: chosen.areaId, total: chips[Math.min(chips.length - 1, Math.floor(rng() * chips.length))] };
}

export function tickHundredRoom(game, ctx, now = Date.now(), rng = Math.random) {
  const { table, io } = ctx;
  const settings = hundredSettings(game, table);
  const options = game.betOptions(table);
  if (!options.areas.length || options.minBet <= 0) return;
  let state = table.hundredRobots;
  if (!state) {
    let humanPresent = false;
    io.forEachPlayer?.(session => { if (!session.bot) humanPresent = true; });
    if (!settings.enabled || !humanPresent) return;
    state = table.hundredRobots = { profiles: new Map(), nextUid: 91000001,
      nextCheckAt: now + delay(settings.checkMinMs, settings.checkMaxMs, rng), initialized: false };
  }
  table.playerSessions ||= new Map();
  table.visitors ||= new Set();
  const notifyPeople = () => io.broadcast(PUSH.PLAYER_NUM_CHANGE, {
    roomType: table.roomType, roomId: table.roomId, playerNum: table.people });
  const enter = profile => {
    profile.inRoom = true;
    profile.joinedAt = now;
    profile.inning = null;
    table.playerSessions.set(profile.session.userId, profile.session);
    if (!table.visitors.has(profile.session.userId)) {
      table.visitors.add(profile.session.userId);
      table.people += 1;
    }
  };
  const leave = profile => {
    profile.inRoom = false;
    profile.canJoinAt = now + delay(settings.cooldownMinMs, settings.cooldownMaxMs, rng);
    table.playerSessions.delete(profile.session.userId);
    if (table.visitors.delete(profile.session.userId)) table.people = Math.max(0, table.people - 1);
  };
  const join = () => {
    let profile = [...state.profiles.values()].find(p => !p.inRoom && now >= p.canJoinAt
      && p.session.wallet >= options.minBet);
    if (!profile) {
      const humans = new Set();
      io.forEachPlayer?.(session => { if (!session.bot) humans.add(Number(session.userId)); });
      while (humans.has(state.nextUid) || table.playerSessions.has(state.nextUid)) state.nextUid += 1;
      const uid = state.nextUid++;
      const opening = Math.min(Number.MAX_SAFE_INTEGER, options.minBet * settings.bankrollBets);
      profile = { session: { userId: uid, name: 'Bot' + (uid - 91000000), bot: true, wallet: opening },
        openingWallet: opening, inRoom: false, canJoinAt: now };
      state.profiles.set(uid, profile);
    }
    enter(profile);
  };
  let changed = false;
  if (!state.initialized) {
    for (let i = 0; i < settings.initialRobots; i++) join();
    state.initialized = true;
    changed = settings.initialRobots > 0;
  }
  for (const [uid, profile] of state.profiles) {
    if (profile.inRoom && !hasPendingHundredBet(table, uid)
      && (!settings.enabled || profile.session.wallet < options.minBet)) {
      leave(profile); changed = true;
    }
    if (!profile.inRoom && now >= profile.canJoinAt && profile.session.wallet < options.minBet) {
      state.profiles.delete(uid);
    }
  }
  if (now >= state.nextCheckAt) {
    state.nextCheckAt = now + delay(settings.checkMinMs, settings.checkMaxMs, rng);
    for (const profile of state.profiles.values()) {
      if (profile.inRoom && !hasPendingHundredBet(table, profile.session.userId)
        && now - profile.joinedAt >= settings.minStayMs && rng() < settings.leaveProbability) {
        leave(profile); changed = true;
      }
    }
    const active = [...state.profiles.values()].filter(p => p.inRoom).length;
    if (settings.enabled && active < settings.targetRobots && rng() < settings.joinProbability) {
      join(); changed = true;
    }
  }
  if (changed) notifyPeople();
  if (!settings.enabled || table.state !== game.betState()
    || (table.phaseEndsAt && now >= table.phaseEndsAt - 500)) return;
  for (const profile of state.profiles.values()) {
    if (!profile.inRoom) continue;
    if (profile.inning !== table.inning) {
      profile.inning = table.inning;
      profile.betsLeft = rng() < settings.participationProbability
        ? delay(1, settings.maxBetsPerRound, rng) : 0;
      profile.nextBetAt = now + delay(settings.betMinMs, settings.betMaxMs, rng);
    }
    if (profile.betsLeft <= 0 || now < profile.nextBetAt) continue;
    profile.nextBetAt = now + delay(settings.betMinMs, settings.betMaxMs, rng);
    profile.betsLeft -= 1;
    const bet = chooseHundredBet({ ...options, balance: profile.session.wallet }, rng);
    if (!bet) continue;
    const session = profile.session;
    const body = { roomType: table.roomType, roomId: table.roomId, params: [bet] };
    // Ordinary bet handler and public totals, with no private robot peer.
    game.placeBet({ ...hundredWalletContext(ctx, session), session, body,
      send() {}, io: { ...io, sendUser() {} } }, body);
  }
}

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
