export const MATCH_STATE_DRAFT = 0;
export const MATCH_STATE_REGISTERING = 1;
export const MATCH_STATE_RUNNING = 2;
export const MATCH_STATE_FINISHED = 3;
export const MATCH_STATE_CANCELLED = 4;

export const REDIS_CHANNEL_MATCH = "match";
export const EVENT_MATCH_UPSERT = "match_upsert";
export const EVENT_MATCH_STATE = "match_state";
export const EVENT_MATCH_SIGN = "match_sign";

export const REWARD_KIND_MONEY = "money";
export const REWARD_KIND_TICKET = "ticket";

export const DEFAULT_CURRENCY = "CNY";
export const TEXAS_GAME_TYPE = 19;
export const TEXAS_MATCH_ROOM = 101;

export function canTransitMatch(from, to) {
  switch (from) {
    case MATCH_STATE_DRAFT:
      return to === MATCH_STATE_REGISTERING || to === MATCH_STATE_CANCELLED;
    case MATCH_STATE_REGISTERING:
      return to === MATCH_STATE_RUNNING || to === MATCH_STATE_CANCELLED;
    case MATCH_STATE_RUNNING:
      return to === MATCH_STATE_FINISHED || to === MATCH_STATE_CANCELLED;
    default:
      return false;
  }
}

export function isMatchLocked(state) {
  return state === MATCH_STATE_RUNNING || state === MATCH_STATE_FINISHED || state === MATCH_STATE_CANCELLED;
}
