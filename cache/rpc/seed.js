function payload(obj) {
  return JSON.stringify(obj);
}

export function seedRooms() {
  return [
    // Captured op=38 catalogs: 13 forced-show and 6 no-show configurations.
    ...[
      [70, 10, 20, 500, 0, 2, true], [1921, 10, 20, 500, 2, 2, true],
      [1, 100, 200, 5000, 0, 2, true], [1922, 100, 200, 5000, 2, 2, true],
      [2, 300, 600, 30000, 0, 2, true], [1923, 300, 600, 30000, 2, 2, true],
      [3, 500, 1000, 50000, 0, 4, true], [4, 1000, 2000, 100000, 0, 4, true],
      [5, 2000, 4000, 200000, 0, 4, true],
      [1927, 100, 200, 100, 8, 2, true], [121, 500, 1000, 500, 8, 2, true],
      [123, 5000, 10000, 5000, 8, 4, true], [1920, 30000, 60000, 30000, 8, 4, true],
      [1924, 10, 20, 500, 0, 2, false], [1928, 10, 20, 500, 2, 2, false],
      [1925, 100, 200, 5000, 0, 2, false], [1929, 100, 200, 5000, 2, 2, false],
      [1926, 300, 600, 30000, 0, 2, false], [1930, 300, 600, 30000, 2, 2, false],
    ].map(([id, sb, bb, carry, mode, classification, show], index) => room({
      game_type: 19, room_type: 19, game_room_config_id: id, small_blind: sb, big_blind: bb,
      carry_min: carry, play_mode: mode, room_classification: classification, force_show_card: Number(show),
      straddle: mode === 8, initial_bet: mode === 8 ? 0 : bb, aof_bet: mode === 8 ? carry : 0,
      sort_index: 1900 + index, category: 'normal',
      name: `${mode === 8 ? 'AOF必推' : mode === 2 ? '暴击德州' : '德州'}${show ? '秀牌' : '不秀牌'} ${sb}/${bb}`,
    })),
    // Original op=38 catalog: ten tables in each baccarat mode. VIP tables
    // share config 5895; room_index is part of their routing identity.
    ...[
      [0, '经典百家乐', [140, 141, 142, 143, 144, 145, 146, 5801, 5802, 5803]],
      [1, '共咪百家乐', [147, 148, 149, 150, 151, 152, 153, 5824, 5825, 5826]],
      [2, '极速百家乐', [154, 155, 156, 157, 158, 159, 5847, 5848, 5849, 5850]],
      [3, '明牌百家乐', [180, 182, 183, 184, 185, 186, 5871, 5872, 5873, 5874]],
      [4, '包桌百家乐', Array(10).fill(5895)],
    ].flatMap(([mode, name, ids]) => ids.map((id, index) => room({
      game_type: 1002, room_type: 58, game_room_config_id: id, play_mode: mode,
      room_index: index + 1, hundred_min_bet: 100, hundred_max_bet: 100000000,
      name: name + ' ' + (index + 1), category: 'hundred', sort_index: 5800 + mode * 10 + index,
    }))),
    // Only tables explicitly identified by captured protocols. The complete
    // online Dragon-Tiger catalog is truncated, so do not invent its IDs.
    ...[[172, 0, 3, '经典龙虎斗'], [163, 1, 4, '共咪龙虎斗'],
      [5906, 3, 6, '明牌龙虎斗'], [5909, 3, 9, '明牌龙虎斗'], [5971, 4, 2, '包桌龙虎斗']]
      .map(([id, mode, index, name]) => room({ game_type: 1003, room_type: 59,
        game_room_config_id: id, play_mode: mode, room_index: index,
        hundred_min_bet: 100, hundred_max_bet: 100000000,
        name: name + ' ' + index, category: 'hundred', sort_index: 5900 + mode * 10 + index })),
    ...[[100, 1, "暗五公牌"], [5002, 2, "明三公牌"], [5003, 3, "明二公牌"],
      [5004, 4, "明一公牌"], [5005, 5, "全暗"]].map(([id, mode, name], index) => room({
      game_type: 1000, room_type: 50, game_room_config_id: id, play_mode: mode,
      room_index: index + 1, hundred_min_bet: 100, hundred_max_bet: 1000000000,
      name: `百人德州 ${name}`, category: "hundred",
    })),
    room({ game_type: 1004, room_type: 61, game_room_config_id: 6101, room_index: 26, carry_min: 100000000, name: "麻将胡了", category: "slots" }),
    room({ game_type: 1004, room_type: 63, game_room_config_id: 6301, room_index: 26, carry_min: 100000000, name: "赏金女王", category: "slots" }),
    ...[[101, 1, '明牌红1黑1'], [5102, 2, '明牌红2黑1'], [5103, 3, '明牌红2黑2'],
      [5104, 4, '明牌红3黑1'], [5105, 5, '全暗']].map(([id, mode, name], index) => room({
      game_type: 1000, room_type: 51, game_room_config_id: id, play_mode: mode,
      room_index: index + 1, hundred_min_bet: 100, hundred_max_bet: 1000000000,
      name: '百人金花 ' + name, category: 'hundred',
    })),
    ...[[102, 1, '牛牛看三张'], [5202, 2, '牛牛看四张'], [5203, 3, '牛牛看二张'],
      [5204, 4, '牛牛看一张'], [5205, 5, '牛牛全暗']].map(([id, mode, name], index) => room({
      game_type: 1000, room_type: 52, game_room_config_id: id, play_mode: mode,
      room_index: index + 1, hundred_min_bet: 100, hundred_max_bet: 1000000000,
      name: '百人' + name, category: 'hundred',
    })),
    room({ game_type: 1000, room_type: 60, game_room_config_id: 6001, play_mode: 0,
      room_index: 0, hundred_min_bet: 100, hundred_max_bet: 1000000000,
      name: '百人21点', category: 'hundred' }),
    room({ game_type: 1000, room_type: 62, game_room_config_id: 6201, play_mode: 0,
      room_index: 0, hundred_min_bet: 100, hundred_max_bet: 1000000000,
      name: '百人麻将', category: 'hundred' }),
    ...[[53,103,'奔驰宝马'],[54,104,'森林舞会'],[55,105,'飞禽走兽'],[56,106,'麻将转了'],[57,107,'趣味捕鱼']]
      .map(([type,id,name]) => room({ game_type: 1001, room_type: type, game_room_config_id: id,
        play_mode: 0, room_index: 0, hundred_min_bet: 100, hundred_max_bet: 100000000,
        name, category: 'hundred' })),
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
    ...[
      [2707, 1, 1, 2, 100], [2703, 0, 200, 4, 20000], [2706, 1, 50, 2, 5000],
      [2709, 1, 200, 4, 20000], [2705, 1, 10, 2, 1000], [2701, 0, 10, 2, 1000],
      [2704, 0, 500, 4, 50000], [2702, 0, 50, 2, 5000],
    ].map(([id, mode, ante, classification, carry], index) => room({
      game_type: 27, room_type: 27, game_room_config_id: id, play_mode: mode,
      ante, carry_min: carry, room_classification: classification, sort_index: 2700 + index,
      name: `十三水${mode ? '八鬼' : '四鬼'} 底注${ante}`, category: 'normal',
    })),
    ...[[3101, 100, 2, 500], [3102, 500, 2, 2500], [3103, 2000, 4, 10000], [3104, 10000, 4, 50000]]
      .map(([id, ante, classification, carry], index) => room({
        game_type: 31, room_type: 31, game_room_config_id: id, play_mode: 0,
        ante, carry_min: carry, room_classification: classification, sort_index: 3100 + index,
        name: `常规二十一点 底注${ante}`, category: 'normal',
      })),
    room({ game_type: 31, room_type: 31, game_room_config_id: 3110, play_mode: 1,
      ante: 100, carry_min: 0, room_classification: 4,
      name: '赌场21点(底注1/1000000)', category: 'normal' }),
    ...[[3203, 3000, 4, 30000], [3204, 5000, 4, 50000], [3201, 500, 2, 5000], [3202, 1000, 2, 10000]]
      .map(([id, ante, classification, carry], index) => room({
        game_type: 32, room_type: 32, game_room_config_id: id, play_mode: 0,
        ante, carry_min: carry, room_classification: classification, sort_index: 3200 + index,
        tax_type: 2, tax_percent: 500, name: `三公暗一(底注${ante / 100})`, category: 'normal',
      })),
    ...[
      [2601,26,0,10,2,2000], [2602,26,0,50,2,10000], [2603,26,0,200,4,50000],
      [2604,26,1,10,2,2000], [2605,26,1,50,2,10000], [2606,26,1,200,4,50000],
      [2801,28,2,10,2,2000], [2802,28,2,50,2,10000], [2803,28,2,200,2,50000],
      [2804,28,4,10,2,2000], [2805,28,4,50,2,10000], [2806,28,4,200,2,50000],
      [3001,30,0,10,2,2000], [3002,30,1,10,2,2000], [3003,30,0,50,2,10000],
      [3004,30,1,50,2,10000], [3005,30,0,20,4,4000], [3006,30,1,20,4,4000],
    ].map(([id,type,mode,ante,classification,carry]) => room({ game_type:type, room_type:type,
      game_room_config_id:id, play_mode:mode, ante, room_classification:classification, carry_min:carry,
      name:`${{26:'极速麻将',28:'长沙麻将',30:'红中血流'}[type]} ${type===28?mode:mode===1?2:4}人 底注${ante/100}`, category:'normal' })),
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
  if ([58, 59].includes(roomType)) {
    const params = { gameName: row.name, gameRoomConfigId: row.game_room_config_id,
      maxBet: row.hundred_max_bet, roomIndex: row.room_index };
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false,
      roomClassification: 0, ante: 0, initialBet: 0, straddle: false, seeCardNo: 0,
      [roomType === 59 ? 'brlhdParams' : 'brbjlParams']: params, hundredParams: params,
      key: [roomType, 0, 0, false, row.play_mode, 0, 0, 0, 0, row.room_index].join('/'),
      ...(row.play_mode === 4 ? { vipTableData: roomType === 59 ? { bg: 51, dealer: 301 } : { bg: 1, dealer: 223 } } : {}),
    });
  }
  if ([53,54,55,56,57].includes(roomType)) {
    const key = {53:'bcbm',54:'slwh',55:'fqzs',56:'mjzl',57:'qwby'}[roomType];
    const params = { gameName: row.name, gameRoomConfigId: row.game_room_config_id,
      maxBet: row.hundred_max_bet, roomIndex: row.room_index || 0 };
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false, maxBet: row.hundred_max_bet,
      hundredParams: params, [key + 'Params']: params });
  }
  if (roomType === 19) {
    Object.assign(payloadObj, { straddle: row.straddle ?? false, initialBet: row.initial_bet ?? row.big_blind,
      roomClassification: row.room_classification ?? 2, aofBet: row.aof_bet ?? 0,
      ante: 0, seeCardNo: 3, openInsurance: false });
    if (row.play_mode === 2) Object.assign(payloadObj, {
      criticalFlag: true, criticalAnte: 100, criticalInterval: '5-8',
    });
    payloadObj.key = [roomType, payloadObj.smallBlind, payloadObj.bigBlind, payloadObj.straddle,
      payloadObj.playMode, payloadObj.initialBet, payloadObj.roomClassification, payloadObj.carryMin, payloadObj.aofBet,
      payloadObj.forceShowCard].join('/');
  }
  if (roomType === 50) {
    const modeNames = { 1: "暗五公牌", 2: "明三公牌", 3: "明二公牌", 4: "明一公牌", 5: "全暗" };
    Object.assign(payloadObj, {
      hundredGame: 1, openHundredGame: false,
      roomClassification: 0, ante: 0, initialBet: 0, straddle: false, seeCardNo: 0,
      maxBet: row.hundred_max_bet,
      hundredParams: {
        gameName: `${modeNames[row.play_mode] || "百人德州"}(底注1)`,
        gameRoomConfigId: row.game_room_config_id,
        maxBet: row.hundred_max_bet,
        betAreaOdds: { 1: 1.91, 2: 0.5, 3: 16.44, 4: 1.61, 5: 2.03, 6: 13.22, 7: 4.9 },
      },
    });
    payloadObj.key = [roomType, 0, 0, false, row.play_mode, 0, 0, 0, 0].join("/");
  }
  if (roomType === 51) {
    const modeNames = {1: '明牌红1黑1', 2: '明牌红2黑1', 3: '明牌红2黑2', 4: '明牌红3黑1', 5: '全暗'};
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false, roomClassification: 0,
      ante: 0, initialBet: 0, straddle: false, seeCardNo: 0, maxBet: row.hundred_max_bet,
      hundredParams: { gameName: modeNames[row.play_mode] + '(底注1)',
        gameRoomConfigId: row.game_room_config_id, maxBet: row.hundred_max_bet } });
    payloadObj.key = [roomType, 0, 0, false, row.play_mode, 0, 0, 0, 0].join('/');
  }
  if (roomType === 52) {
    const modeNames = {1: '牛牛看三张', 2: '牛牛看四张', 3: '牛牛看二张', 4: '牛牛看一张', 5: '牛牛全暗'};
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false, roomClassification: 0,
      ante: 0, initialBet: 0, straddle: false, seeCardNo: 0, maxBet: row.hundred_max_bet,
      hundredParams: { gameName: modeNames[row.play_mode] + '(底注1)',
        gameRoomConfigId: row.game_room_config_id, maxBet: row.hundred_max_bet,
        specialPayoutMultiple: 10 } }); // Development default; formal multiplier is not yet confirmed.
    payloadObj.key = [roomType, 0, 0, false, row.play_mode, 0, 0, 0, 0].join('/');
  }
  if (roomType === 62) {
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false, roomClassification: 0,
      ante: 0, initialBet: 0, straddle: false, seeCardNo: 0, maxBet: row.hundred_max_bet,
      hundredParams: { gameName: '百人麻将', gameRoomConfigId: row.game_room_config_id, maxBet: row.hundred_max_bet } });
    payloadObj.key = [roomType, 0, 0, false, row.play_mode, 0, 0, 0, 0].join('/');
  }
  if (roomType === 60) {
    Object.assign(payloadObj, { hundredGame: 1, openHundredGame: false, roomClassification: 0,
      ante: 0, initialBet: 0, straddle: false, seeCardNo: 0, maxBet: row.hundred_max_bet,
      hundredParams: { gameName: '百人21点', gameRoomConfigId: row.game_room_config_id,
        maxBet: row.hundred_max_bet, cutIndex: 262 } });
    payloadObj.key = [roomType, 0, 0, false, 0, 0, 0, 0, 0].join('/');
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
  if ([26, 27, 28, 30, 31, 32].includes(roomType)) {
    Object.assign(payloadObj, { ante: row.ante, initialBet: 0, seeCardNo: 0,
      roomClassification: row.room_classification, maxPeople: roomType === 32 ? 7 : roomType === 31 ? row.play_mode === 1 ? 5 : 3 : 4, straddle: false });
    payloadObj.key = [roomType, row.play_mode, row.ante, row.room_classification, row.carry_min].join('/');
    if ([26, 28, 30].includes(roomType)) payloadObj.maxPeople = roomType === 28 ? row.play_mode : row.play_mode === 1 ? 2 : 4;
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
