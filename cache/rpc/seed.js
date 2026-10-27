function payload(obj) {
  return JSON.stringify(obj);
}

export function seedRooms() {
  return [
    room({ game_type: 19, room_type: 19, game_room_config_id: 70, small_blind: 10, big_blind: 20, carry_min: 500, force_show_card: 1, play_mode: 0, name: "德州 10/20", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 1, small_blind: 100, big_blind: 200, carry_min: 5000, force_show_card: 1, play_mode: 0, name: "德州 100/200", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 2, small_blind: 300, big_blind: 600, carry_min: 30000, force_show_card: 1, play_mode: 0, name: "德州 300/600", category: "normal" }),
    // Standard no-show tiers from doc/协议/大厅/德州-德州不秀牌大厅消息协议.md.
    room({ game_type: 19, room_type: 19, game_room_config_id: 1924, small_blind: 10, big_blind: 20, carry_min: 500, force_show_card: 0, play_mode: 0, name: "德州不秀牌 10/20", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 1925, small_blind: 100, big_blind: 200, carry_min: 5000, force_show_card: 0, play_mode: 0, name: "德州不秀牌 100/200", category: "normal" }),
    room({ game_type: 19, room_type: 19, game_room_config_id: 1926, small_blind: 300, big_blind: 600, carry_min: 30000, force_show_card: 0, play_mode: 0, name: "德州不秀牌 300/600", category: "normal" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5803, play_mode: 0, room_index: 1, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 1", category: "hundred" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5804, play_mode: 0, room_index: 2, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 2", category: "hundred" }),
    room({ game_type: 1002, room_type: 58, game_room_config_id: 5805, play_mode: 0, room_index: 3, hundred_min_bet: 100, hundred_max_bet: 100000000, name: "经典百家乐 3", category: "hundred" }),
    room({ game_type: 1004, room_type: 61, game_room_config_id: 6101, room_index: 26, carry_min: 100000000, name: "麻将胡了", category: "slots" }),
    room({ game_type: 1004, room_type: 63, game_room_config_id: 6301, room_index: 26, carry_min: 100000000, name: "赏金女王", category: "slots" }),
    ...[
      [2501, 3, 10, 100, 2, "炸金花"],
      [16, 3, 100, 1000, 2, "炸金花"],
      [17, 3, 500, 5000, 4, "炸金花"],
      [125, 3, 2000, 50000, 4, "炸金花"],
      [134, 2, 100, 1000, 2, "看二张"],
      [73, 2, 500, 5000, 2, "看二张"],
      [74, 2, 2000, 50000, 4, "看二张"],
      [2503, 5, 10, 100, 2, "看一张"],
      [2502, 5, 100, 1000, 2, "看一张"],
    ].map(([id, mode, ante, carry, classification, name], index) => room({
      game_type: 21, room_type: 25, game_room_config_id: id, play_mode: mode,
      ante, carry_min: carry, room_classification: classification,
      sort_index: 2500 + index, force_show_card: 1,
      name: `${name} 底注${ante}`, category: "normal",
    })),
    ...[
      [71,3,20,3,2,2000], [2410,7,30,4,2,20000], [19,3,10,4,2,1000],
      [69,3,50,4,4,5000], [2406,0,10,0,2,1000], [2401,3,200,3,4,50000],
      [2402,7,1,4,2,500], [2403,7,50,4,2,50000], [126,3,200,4,4,50000],
      [131,7,10,4,2,5000], [2411,3,100,4,4,20000], [72,3,50,3,4,10000],
      [2408,0,50,0,2,5000], [2412,3,1,3,4,100],
    ].map(([id, mode, ante, see, classification, carry], index) => room({
      game_type: 20, room_type: 24, game_room_config_id: id, play_mode: mode,
      ante, see_card_no: see, room_classification: classification, carry_min: carry,
      sort_index: 2400 + index, category: 'normal',
      name: `${mode === 7 ? '七癞牛牛' : mode === 0 ? '全暗牛牛' : `看${see}张牛牛`} 底注${ante}`,
    })),
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
  if (roomType === 19) {
    Object.assign(payloadObj, { straddle: false, initialBet: row.big_blind,
      roomClassification: 2, aofBet: 0, seeCardNo: 3, openInsurance: false });
    payloadObj.key = [roomType, payloadObj.smallBlind, payloadObj.bigBlind, false,
      payloadObj.playMode, payloadObj.initialBet, 2, payloadObj.carryMin, 0,
      payloadObj.forceShowCard].join('/');
  }
  if (roomType === 25) {
    Object.assign(payloadObj, { ante: row.ante, initialBet: row.ante, straddle: false,
      roomClassification: row.room_classification || 2, seeCardNo: 0, aofBet: 0,
      maxPeople: 7, disusePoint: Math.max(0, row.carry_min - row.ante),
      randomSit: true, banTalk: true, banEmulator: false });
    if (row.play_mode === 2) Object.assign(payloadObj, { taxType: 2, taxPercent: 500 });
    payloadObj.key = [25, payloadObj.playMode, row.ante, payloadObj.roomClassification,
      payloadObj.carryMin].join('/');
  }
  if (roomType === 24) {
    Object.assign(payloadObj, { ante: row.ante, initialBet: row.ante, seeCardNo: row.see_card_no,
      roomClassification: row.room_classification, maxPeople: 7 });
    payloadObj.key = [24, row.play_mode, row.ante, row.see_card_no, row.room_classification, row.carry_min].join('/');
  }
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
