export const OP = Object.freeze({ DRAW: 1, DISCARD: 2, PENG: 3, AN_GANG: 4, BU_GANG: 5, DIAN_GANG: 6,
  PASS: 7, HU: 8, TING: 9, FIRST: 10, MID_HU: 11, CHI: 12, TAIL: 13, PROMPT: 14, BU: 16 });
export const PROTOCOL = Object.freeze({
  jsmj: { action: 3600, history: 3601, query: 3602, snapshot: 3800, deal: 3801, turn: 3802, event: 3803, settle: 3804, first: 3806, historyPush: 3807, queryPush: 3808 },
  csmj: { action: 3750, history: 3751, query: 3752, snapshot: 4200, deal: 4201, turn: 4202, event: 4203, settle: 4204, first: 4206, historyPush: 4207, queryPush: 4208 },
  hzxl: { action: 3650, history: 3651, query: 3655, snapshot: 3850, deal: 3851, turn: 3852, event: 3853, settle: 3854, historyPush: 3857, queryPush: 3867 },
});
