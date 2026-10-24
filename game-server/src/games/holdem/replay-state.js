// Holdem history in the client uses the numeric GameState enum. These values
// are also used by the client's replay timeline (BET_PERFLOP=4, BET_FLOP=6,
// BET_TURN=8, BET_RIVER=10).
export const REPLAY_GAME_STATE = {
  BET_FRONT: 1,
  BET_BLIND: 2,
  DEAL_FLOP: 5,
  BET_PERFLOP: 4,
  DEAL_TURN: 7,
  BET_FLOP: 6,
  DEAL_RIVER: 9,
  BET_TURN: 8,
  BET_RIVER: 10,
};

