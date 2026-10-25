import { rel } from "./rel.js";

const MAX_PEOPLE = 10_000_000;
const ENTRY_FIELDS = [
  ["carryMin", "carry_min"],
  ["hundredMinBet", "hundred_min_bet"],
  ["ante", "ante"],
  ["initialBet", "initial_bet"],
  ["bigBlind", "big_blind"],
  ["smallBlind", "small_blind"],
];

function numeric(value) {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== ""))
    && Number.isFinite(Number(value)) ? Number(value) : NaN;
}

function bounded(value, fallback, min, max) {
  const number = numeric(value);
  return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function formatter(timeZone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// Admission first; games without a buy-in use their configured minimum stake.
export function roomEntryAmount(room, row = {}) {
  for (const [clientField, storeField] of ENTRY_FIELDS) {
    const amount = numeric(room[clientField] ?? row[storeField]);
    if (amount > 0) return amount;
  }
  return 0;
}

function randomUnit(key, bucket) {
  let hash = 2166136261;
  const text = key + ":" + bucket;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967295;
}

export async function createRoomPopulation(overrides = {}, version = 0) {
  const { roomPopulationConfig: defaults } = await rel(import.meta.url, "./room-population-config.js", version);
  const input = overrides && typeof overrides === "object" ? overrides : {};
  const minPeople = Math.round(bounded(input.minPeople, defaults.minPeople, 0, MAX_PEOPLE));
  const refreshSeconds = bounded(input.refreshSeconds, defaults.refreshSeconds, 1, 3600);
  const activityInput = input.activity || {};
  const midnight = bounded(activityInput.midnight, defaults.activity.midnight, 0, 1);
  const low = bounded(activityInput.low, defaults.activity.low, 0, midnight);
  const noon = bounded(activityInput.noon, defaults.activity.noon, low, midnight);
  const afternoon = bounded(activityInput.afternoon, defaults.activity.afternoon, low, noon);
  let clock;
  try { clock = formatter(input.timeZone ?? defaults.timeZone); }
  catch { clock = formatter(defaults.timeZone); }
  const settings = Object.freeze({
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaults.enabled,
    timeZone: clock.resolvedOptions().timeZone,
    refreshSeconds,
    minPeople,
    maxPeople: Math.round(bounded(input.maxPeople, defaults.maxPeople, minPeople, MAX_PEOPLE)),
    entryReference: bounded(input.entryReference, defaults.entryReference, 1, Number.MAX_SAFE_INTEGER),
    entryDecay: bounded(input.entryDecay, defaults.entryDecay, 0.01, 4),
    randomAmplitude: bounded(input.randomAmplitude, defaults.randomAmplitude, 0, 0.5),
    randomPeriodSeconds: bounded(input.randomPeriodSeconds, defaults.randomPeriodSeconds, refreshSeconds, 86400),
    seed: typeof input.seed === "string" ? input.seed.slice(0, 128) : defaults.seed,
    activity: Object.freeze({ midnight, low, noon, afternoon }),
  });
  const anchors = [[0, midnight], [3, low], [6, low], [12, noon], [14, afternoon], [24, midnight]];

  function activityAt(time) {
    const parts = Object.fromEntries(clock.formatToParts(time).map((part) => [part.type, part.value]));
    const hour = Number(parts.hour) + Number(parts.minute) / 60 + Number(parts.second) / 3600;
    for (let i = 1; i < anchors.length; i++) {
      const [end, to] = anchors[i];
      if (hour <= end) {
        const [start, from] = anchors[i - 1];
        return from + (to - from) * (hour - start) / (end - start);
      }
    }
    return midnight;
  }

  function decorate(room, row = {}, now = Date.now()) {
    if (!settings.enabled) return room;
    const time = Math.floor(now / (settings.refreshSeconds * 1000)) * settings.refreshSeconds * 1000;
    const phase = time / (settings.randomPeriodSeconds * 1000);
    const bucket = Math.floor(phase);
    const fraction = phase - bucket;
    const smooth = fraction * fraction * (3 - 2 * fraction);
    // One fluctuation per game: higher entry cannot overtake lower entry.
    // Derived from time, so repeated requests, multiple halls and hot reloads
    // with identical configuration produce the same count, without a timer/map.
    const key = settings.seed + ":" + String(row.game_type ?? room.gameType ?? room.roomType);
    const start = randomUnit(key, bucket);
    const random = start + (randomUnit(key, bucket + 1) - start) * smooth;
    const noise = 1 + (random * 2 - 1) * settings.randomAmplitude;
    const entryFactor = Math.pow(1 + roomEntryAmount(room, row) / settings.entryReference, -settings.entryDecay);
    const count = settings.minPeople + (settings.maxPeople - settings.minPeople)
      * entryFactor * activityAt(time) * noise;
    return { ...room, totalPeople: Math.max(settings.minPeople, Math.min(settings.maxPeople, Math.round(count))) };
  }

  return { enabled: settings.enabled, settings, decorate };
}
