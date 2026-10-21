function payload(obj) {
  return JSON.stringify(obj);
}

export function seedRooms() {
  return [
    room({ game_type: 19, room_type: 19, game_room_config_id: 70, small_blind: 10, big_blind: 20, carry_min: 500, force_show_card: 1, play_mode: 0, name: "德州 10/20", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 1, small_blind: 100, big_blind: 200, carry_min: 5000, force_show_card: 1, play_mode: 0, name: "德州 100/200", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 2, small_blind: 300, big_blind: 600, carry_min: 30000, force_show_card: 1, play_mode: 0, name: "德州 300/600", category: "normal" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5803, play_mode: 0, room_index: 1, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 1", category: "hundred" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5804, play_mode: 0, room_index: 2, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 2", category: "hundred" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5805, play_mode: 0, room_index: 3, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 3", category: "hundred" }),
    room({ game_type: 1004, room_type: 61, game_room_config_id: 6101, room_index: 26, carry_min: 100000000, name: "麻将胡了", category: "slots" }),
    room({ game_type: 1004, room_type: 63, game_room_config_id: 6301, room_index: 26, carry_min: 100000000, name: "赏金女王", category: "slots" }),
    room({ game_type: 21, room_type: 25, game_room_config_id: 2501, play_mode: 3, carry_min: 100, force_show_card: 1, name: "炸金花 底注10", category: "normal" }),
  ];
}

function room(row) {
  const now = Math.floor(Date.now() / 1000);
  const roomType = row.room_type;
  const payloadObj = {
    roomType,
    gameRoomConfigId: row.game_room_config_id,
    totalPeople: 0,
    smallBlind: row.small_blind || 0,
    bigBlind: row.big_blind || 0,
    carryMin: row.carry_min || 0,
    playMode: row.play_mode || 0,
    roomIndex: row.room_index || 0,
    forceShowCard: Boolean(row.force_show_card),
    hundredMinBet: row.hundred_min_bet || 0,
    hundredMaxBet: row.hundred_max_bet || 0,
    key: `${roomType}/${row.small_blind || 0}/${row.big_blind || 0}`,
  };
  return {
    id: row.game_room_config_id,
    state: 1,
    sort_index: row.game_room_config_id,
    create_time: now,
    update_time: now,
    payload: payload(payloadObj),
    room_index: 0,
    small_blind: 0,
    big_blind: 0,
    carry_min: 0,
    force_show_card: 0,
    play_mode: 0,
    hundred_min_bet: 0,
    hundred_max_bet: 0,
    ...row,
  };
}

export function seedAwards() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id: 1, name: "德州每日免费赛奖励", detail: JSON.stringify([{ rank: 1, items: [{ kind: "money", currency: "CNY", amount: "50000" }] }]), create_time: now, update_time: now },
    { id: 2, name: "德州付费赛奖励", detail: JSON.stringify([{ rank: 1, items: [{ kind: "money", currency: "CNY", amount: "100000" }] }]), create_time: now, update_time: now },
  ];
}

export function seedTickets() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id: 1, name: "通用门票", price: 100, currency: "CNY", match_id: 0, num: 100000, remain: 100000, create_time: now, update_time: now },
  ];
}

export function seedRates() {
  const now = Math.floor(Date.now() / 1000);
  return [
    { id: 1, currency: "CNY", rate: "100", create_time: now, update_time: now },
    { id: 2, currency: "USD", rate: "14", create_time: now, update_time: now },
  ];
}

export function seedBlinds() {
  const now = Math.floor(Date.now() / 1000);
  return [{ id: 1, name: "德州MTT标准盲注", data: "[]", create_time: now, update_time: now }];
}

export function seedMatches() {
  const now = Math.floor(Date.now() / 1000);
  const ms = Date.now();
  return [
    {
      id: 2,
      championship_name: JSON.stringify([{ lang: "zh_cn", championshipName: "德州每日免费赛" }]),
      game_type: 19,
      room_type: 101,
      register_type: 4,
      currency: "CNY",
      init_point: 500000,
      min_player: 2,
      max_player: 5000,
      force_show_card: 1,
      award_id: 1,
      state: 1,
      start_time: ms + 2 * 3600 * 1000,
      sort_index: 1,
      big_blind: 100,
      small_blind: 50,
      domain: "127.0.0.1:11041",
      shield: "jt-room1",
      create_time: now,
      update_time: now,
    },
  ];
}
