import { asMs, num, truthy } from "./decode.js";

export const MATCH_STATE_DRAFT = 0;
export const MATCH_STATE_REGISTERING = 1;
export const MATCH_STATE_RUNNING = 2;
export const MATCH_STATE_FINISHED = 3;
export const MATCH_STATE_CANCELLED = 4;

export function isListedMatch(row) {
  const state = num(row?.state, MATCH_STATE_DRAFT);
  return state === MATCH_STATE_REGISTERING || state === MATCH_STATE_RUNNING;
}

export function toClientMatch(row, opts = {}) {
  if (!row) {
    return null;
  }
  const state = num(row.state, MATCH_STATE_DRAFT);
  const startTime = asMs(row.start_time);
  const player = opts.player || null;
  const playerStatus = player ? num(player.status, 1) : 0;
  const points=(opts.players||[]).filter(p=>[1,4].includes(Number(p.status))).map(p=>num(p.points,0));
  let championshipStatus = 1;
  let status = 1;
  if (state === MATCH_STATE_RUNNING) {
    championshipStatus = 2;
    status = 2;
  } else if (state === MATCH_STATE_FINISHED || state === MATCH_STATE_CANCELLED) {
    championshipStatus = 3;
    status = 3;
  }
  const domain = row.domain || opts.gameServer || "";
  return {
    id: num(row.id, 0),
    startDate: String(startTime),
    startTime,
    endTime: asMs(row.end_time),
    championshipName: row.championship_name || "[]",
    registerType: num(row.register_type, 4),
    registerGold: num(row.register_gold, 0),
    serviceGold: num(row.service_gold, 0),
    championshipType: num(row.championship_type, 1),
    blindType: num(row.blind_type, 2),
    registerTicket: num(row.register_ticket, 0),
    ticketValue: num(row.ticket_value, 0),
    ticketName: row.ticket_name || null,
    consults: row.consults || null,
    gameType: num(row.game_type, 19),
    initPoint: num(row.init_point, 0),
    currentPlayer: num(row.current_player, 0),
    createTime: String(asMs(row.create_time)),
    freeTypePot: num(row.free_type_pot, 0),
    reBuyTime: num(row.rebuy_time, 0),
    delayRegisterLevel: num(row.delay_register_level, 0),
    delayRegisterTime: num(row.delay_register_time, 0),
    restTime: num(row.rest_time, 0),
    restTimeInterval: num(row.rest_time_interval, 0),
    sortIndex: num(row.sort_index, 0),
    currentLivePlayer: num(row.current_live_player, 0),
    championshipStatus,
    playerStatus,
    registerStatus: state === MATCH_STATE_REGISTERING ? 1 : state === MATCH_STATE_RUNNING ? 3 : 0,
    showTime: num(row.delay_register_time, 0),
    totalPot: num(row.total_pot, 0),
    bonusPot: num(row.bonus_pot, 0),
    bigBlind: num(row.big_blind, 0),
    status,
    increaseBindTime: num(row.increase_bind_time, 0),
    registerTimeLimit: num(row.register_time_limit, 0),
    blindLevel: num(row.blind_level, 0),
    bountyPot: num(row.bounty_pot, 0),
    maxPlayer: num(row.max_player, 0),
    minPlayer: num(row.min_player, 0),
    maxPoint: points.length?Math.max(...points):0,
    minPoint: points.length?Math.min(...points):0,
    avgPoint: points.length?Math.floor(points.reduce((n,p)=>n+p,0)/points.length):0,
    myRank: player ? num(player.rank, 0) : 0,
    nextUpBlindTime: 0,
    nextBlindLastTime: 0,
    startRestTime: 0,
    forceShowCard: truthy(row.force_show_card),
    fixPot: truthy(row.fix_pot),
    register: Boolean(player),
    rest: false,
    domain,
    shield: row.shield || "",
    roomType: num(row.room_type, 101),
    MTTRoomInfos: (opts.tables || []).map((item) => ({
      roomIndex: num(item.room_index, 0),
      roomId: num(item.room_id, 0),
      playerNums: num(item.player_nums, 0),
    })),
  };
}

export function toClientRoom(row) {
  let payload = {};
  if (row?.payload) {
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }
  }
  return {
    ...payload,
    roomType: num(payload.roomType ?? row.room_type, 0),
    gameRoomConfigId: num(payload.gameRoomConfigId ?? row.game_room_config_id, 0),
    playMode: num(payload.playMode ?? row.play_mode, 0),
    roomIndex: num(payload.roomIndex ?? row.room_index, 0),
    smallBlind: num(payload.smallBlind ?? row.small_blind, 0),
    bigBlind: num(payload.bigBlind ?? row.big_blind, 0),
    carryMin: num(payload.carryMin ?? row.carry_min, 0),
    forceShowCard: payload.forceShowCard ?? truthy(row.force_show_card),
    totalPeople: num(payload.totalPeople, 0),
    serverNow: Date.now(),
  };
}
