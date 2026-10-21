import assert from "node:assert/strict";
import test from "node:test";
import * as decode from "./decode.js";
import { createRoomLogic } from "./rooms.js";

const rooms = createRoomLogic(decode);
const rows = [
  { game_type: 19, room_type: 19, game_room_config_id: 70, play_mode: 0, room_index: 0, small_blind: 10, big_blind: 20, force_show_card: 1, state: 1, sort_index: 1 },
  { game_type: 1002, room_type: 58, game_room_config_id: 5803, play_mode: 0, room_index: 1, small_blind: 0, big_blind: 0, force_show_card: 0, state: 1, sort_index: 1 },
];

test("filter rooms by gameType", () => {
  const texas = rooms.filterRooms(rows, { gameType: 19, forceShowCard: 1 });
  assert.equal(texas.length, 1);
  assert.equal(texas[0].game_room_config_id, 70);
});

test("find room by blinds and return enter payload", () => {
  const row = rooms.findRoom(rows, { gameType: 19, roomType: 19, smallBlind: 10, bigBlind: 20, playMode: 0 });
  assert.equal(row.game_room_config_id, 70);
  const payload = rooms.enterRoomPayload(row, { roomType: 19 }, { game_server: "127.0.0.1:11041", hundred_server: "127.0.0.1:11041" });
  assert.equal(payload.roomId, rooms.assignRoomId(row));
  assert.equal(payload.roomType, 19);
  assert.equal(payload.domain, "127.0.0.1:11041");
  assert.equal(payload.hundredDomain, "127.0.0.1:11041");
});
