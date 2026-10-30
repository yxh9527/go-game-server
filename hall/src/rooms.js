import { rel } from "./rel.js";
const v = new URL(import.meta.url).searchParams.get('v') || '0';
const { holdemRoomSettings, holdemRoomKey } = await rel(import.meta.url, '../../shared/holdem-room.js', v);

export function createRoomLogic(decode) {
  const { num, truthy } = decode;

  function filterRooms(rows, params = {}) {
    const gameType = num(params.gameType, undefined);
    const subGameType = params.subGameType === undefined || params.subGameType === ''
      ? undefined : num(params.subGameType, undefined);
    const roomType = params.roomType === undefined || params.roomType === ''
      ? (gameType === 1000 ? { 1: 50, 2: 51, 3: 52, 4: 60, 5: 62 }[subGameType] : undefined)
      : num(params.roomType, undefined);
    const playMode = params.playMode === undefined || params.playMode === "" ? undefined : num(params.playMode, 0);
    const forceShowCard = params.forceShowCard === undefined || params.forceShowCard === ""
      ? undefined
      : truthy(params.forceShowCard);
    return (rows || []).filter((row) => {
      if (num(row.state, 1) !== 1) {
        return false;
      }
      if (gameType !== undefined && num(row.game_type, 0) !== gameType) {
        return false;
      }
      if (roomType !== undefined && num(row.room_type, 0) !== roomType) {
        return false;
      }
      if (playMode !== undefined && num(row.play_mode, 0) !== playMode) {
        return false;
      }
      if (forceShowCard !== undefined && truthy(row.force_show_card) !== forceShowCard) {
        return false;
      }
      return true;
    }).sort((a, b) => num(a.sort_index, 0) - num(b.sort_index, 0));
  }

  function findRoom(rows, params = {}) {
    const cfgId = num(params.gameRoomConfigId, undefined);
    const roomType = num(params.roomType, undefined);
    const playMode = params.playMode === undefined || params.playMode === "" ? undefined : num(params.playMode, 0);
    const roomIndex = params.roomIndex === undefined || params.roomIndex === "" ? undefined : num(params.roomIndex, 0);
    const smallBlind = params.smallBlind === undefined || params.smallBlind === "" ? undefined : num(params.smallBlind, 0);
    const bigBlind = params.bigBlind === undefined || params.bigBlind === "" ? undefined : num(params.bigBlind, 0);
    const ante = params.ante === undefined || params.ante === "" ? undefined : num(params.ante, 0);
    const carryMin = params.carryMin === undefined || params.carryMin === "" ? undefined : num(params.carryMin, 0);
    const seeCardNo = params.seeCardNo === undefined || params.seeCardNo === "" ? undefined : num(params.seeCardNo, 0);
    const classification = params.roomClassification === undefined || params.roomClassification === ""
      ? undefined : num(params.roomClassification, 2);
    const forceShowCard = params.forceShowCard === undefined || params.forceShowCard === ""
      ? undefined
      : truthy(params.forceShowCard);
    // Visibility is a room identity, never a soft preference that can fall
    // back to a forced-show table when the requested no-show tier is missing.
    const scored = (rows || []).filter((row) => num(row.state, 1) === 1
      && (cfgId === undefined || num(row.game_room_config_id, 0) === cfgId)
      && (roomType === undefined || num(row.room_type, 0) === roomType)
      && (num(row.room_type, 0) !== 58 || roomIndex === undefined || num(row.room_index, 0) === roomIndex)
      && (playMode === undefined || num(row.play_mode, 0) === playMode
        || (num(row.room_type, 0) === 62 && [0, 1].includes(playMode) && [0, 1].includes(num(row.play_mode, 0))))
      && (smallBlind === undefined || num(row.small_blind, 0) === smallBlind)
      && (bigBlind === undefined || num(row.big_blind, 0) === bigBlind)
      && (num(row.room_type, 0) !== 19 || matchesHoldem(row, params))
      && (![24, 25, 26, 27, 28, 30, 31, 32].includes(num(row.room_type, 0)) || ((ante === undefined || roomAnte(row) === ante)
        && (carryMin === undefined || num(row.carry_min, 0) === carryMin)
        && (classification === undefined || roomClassification(row) === classification)))
      && (num(row.room_type, 0) !== 24 || seeCardNo === undefined || roomSeeCardNo(row) === seeCardNo)
      && (forceShowCard === undefined || truthy(row.force_show_card) === forceShowCard))
      .map((row) => {
      let score = 0;
      if (cfgId !== undefined && num(row.game_room_config_id, 0) === cfgId) {
        score += 8;
      }
      if (roomType !== undefined && num(row.room_type, 0) === roomType) {
        score += 4;
      }
      if (playMode !== undefined && num(row.play_mode, 0) === playMode) {
        score += 2;
      }
      if (roomIndex !== undefined && num(row.room_index, 0) === roomIndex) {
        score += 2;
      }
      if (smallBlind !== undefined && num(row.small_blind, 0) === smallBlind) {
        score += 2;
      }
      if (bigBlind !== undefined && num(row.big_blind, 0) === bigBlind) {
        score += 2;
      }
      if (forceShowCard !== undefined && truthy(row.force_show_card) === forceShowCard) {
        score += 1;
      }
      return { row, score };
    }).filter((item) => item.score > 0);
    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.row || null;
  }

  function assignRoomId(row) {
    return num(row.game_room_config_id, 0) * 10000 + num(row.room_index, 0);
  }

  function hundredHostRoom(rows, hundredRoomType = 50) {
    // Captured op=45 for roomType=50 opens a normal Holdem observer table.
    // Bairen is an overlay of that scene, not a roomType=50 scene.
    const hostType = {50: 19, 51: 25, 52: 24, 60: 31, 62: 26}[Number(hundredRoomType)];
    const hostMode = [24, 25].includes(hostType) ? 3 : 0;
    const seeCards = row => {
      let payload = {};
      try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload || {}; } catch {}
      return num(row.see_card_no, num(payload.seeCardNo ?? payload.qznn?.seeCardNo, 0));
    };
    return (rows || []).filter(row => num(row.state, 1) === 1
      && num(row.room_type, 0) === hostType && num(row.play_mode, 0) === hostMode
      && (hostType !== 24 || seeCards(row) === 4)
      && (hostType !== 26 || (() => {
        try { return Number((typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload)?.maxPeople) === 4; } catch { return false; }
      })()))
      .sort((a, b) => num(a.carry_min, 0) - num(b.carry_min, 0)
        || num(a.sort_index, 0) - num(b.sort_index, 0))[0] || null;
  }

  function matchesHoldem(row, params) {
    const fields = holdemRoomSettings(row);
    if (params.key !== undefined && params.key !== '' && params.key !== holdemRoomKey(row)) return false;
    return ['straddle', 'initialBet', 'ante', 'roomClassification', 'carryMin', 'aofBet', 'seeCardNo']
      .every(key => params[key] === undefined || params[key] === ''
        || (key === 'straddle' ? truthy(params[key]) : num(params[key], NaN)) === fields[key]);
  }

  function roomAnte(row) {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch {}
    return num(row.ante, num(payload.ante, 10));
  }

  function roomClassification(row) {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch {}
    return num(row.room_classification, num(payload.roomClassification, 2));
  }

  function roomSeeCardNo(row) {
    let payload = {};
    try { payload = JSON.parse(row.payload || "{}"); } catch {}
    return num(row.see_card_no, num(payload.seeCardNo, 4));
  }

  function enterRoomPayload(row, params, config) {
    const roomType = num(row.room_type, 0);
    const playMode = num(row.play_mode, 0);
    const roomIndex = num(params.roomIndex, num(row.room_index, 0));
    const smallBlind = num(row.small_blind, 0);
    const bigBlind = num(row.big_blind, 0);
    return {
      roomId: assignRoomId(row),
      roomType,
      playMode,
      roomIndex,
      smallBlind,
      bigBlind,
      ...(roomType === 19 ? holdemRoomSettings(row) : {}),
      ...([24, 25, 26, 27, 28, 30, 31, 32].includes(roomType) ? { ante: roomAnte(row), initialBet: [26, 27, 28, 30, 31, 32].includes(roomType) ? 0 : roomAnte(row),
        roomClassification: roomClassification(row), seeCardNo: roomType === 24 ? roomSeeCardNo(row) : 0 } : {}),
      carryMin: num(row.carry_min, 0),
      forceShowCard: truthy(row.force_show_card),
      gameRoomConfigId: num(row.game_room_config_id, 0),
      key: roomType === 19 ? holdemRoomKey(row)
        : [25, 26, 27, 28, 30, 31, 32].includes(roomType) ? [roomType, playMode, roomAnte(row), roomClassification(row), num(row.carry_min, 0)].join('/')
          : roomType === 24 ? [24, playMode, roomAnte(row), roomSeeCardNo(row), roomClassification(row), num(row.carry_min, 0)].join('/')
            : `${roomType}/${smallBlind}/${bigBlind}`,
      domain: config.game_server || "",
      // Ordinary games also load the shared Bairen panel and unsubscribe on
      // exit. Its original socket selector requires this endpoint even when
      // no hundred-player room was entered; a shared server reuses domain.
      hundredDomain: config.hundred_server || config.game_server || "",
    };
  }

  return { filterRooms, findRoom, assignRoomId, hundredHostRoom, enterRoomPayload };
}
