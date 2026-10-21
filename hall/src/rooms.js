export function createRoomLogic(decode) {
  const { num, truthy } = decode;

  function filterRooms(rows, params = {}) {
    const gameType = num(params.gameType, undefined);
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
    const forceShowCard = params.forceShowCard === undefined || params.forceShowCard === ""
      ? undefined
      : truthy(params.forceShowCard);
    const scored = (rows || []).map((row) => {
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

  function enterRoomPayload(row, params, config) {
    return {
      roomId: assignRoomId(row),
      roomType: num(params.roomType, num(row.room_type, 0)),
      domain: config.game_server || "",
      hundredDomain: config.hundred_server || config.game_server || "",
    };
  }

  return { filterRooms, findRoom, assignRoomId, enterRoomPayload };
}
