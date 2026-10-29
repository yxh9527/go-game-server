import assert from "node:assert/strict";
import test from "node:test";
import * as decode from "../../hall/src/decode.js";
import { createRoomLogic } from "../../hall/src/rooms.js";
import { publicHundredWsHost, publicWsHost } from "../../hall/src/web.js";
import { seedRooms } from "../../cache/rpc/seed.js";

const rooms = createRoomLogic(decode);

test('hundred Holdem lists all five modes and selects a configured ordinary host', () => {
  const rows = seedRooms();
  const hundred = rooms.filterRooms(rows, { gameType: 1000 }).filter(row => row.room_type === 50);
  assert.deepEqual(hundred.map(row => row.play_mode), [1, 2, 3, 4, 5]);
  for (const row of hundred) {
    const payload = JSON.parse(row.payload);
    assert.equal(payload.hundredGame, 1);
    assert.equal(payload.roomClassification, 0);
    assert.equal(payload.key, `50/0/0/false/${row.play_mode}/0/0/0/0`);
    assert.equal(rooms.findRoom(rows, payload), row);
  }
  const host = rooms.hundredHostRoom(rows);
  assert.equal(host.room_type, 19);
  assert.equal(host.play_mode, 0);
  assert.equal(host.game_room_config_id, 70);
  assert.equal(rooms.hundredHostRoom(hundred), null, 'never fabricate a host configuration');
  assert.equal(rooms.hundredHostRoom([{ ...host, state: 0 }]), null);
});

test('blackjack lobby keeps four ordinary tiers and the documented casino mode', () => {
  const rows=seedRooms();
  const blackjack=rooms.filterRooms(rows,{gameType:31});
  assert.equal(blackjack.length,5);
  assert.equal(rooms.filterRooms(rows,{gameType:31,playMode:0}).length,4);
  const casino=rooms.filterRooms(rows,{gameType:31,playMode:1});
  assert.equal(casino.length,1);assert.equal(casino[0].game_room_config_id,3110);
  const p=JSON.parse(casino[0].payload);
  assert.equal(p.key,'31/1/100/4/0');assert.equal(p.playMode,1);assert.equal(p.maxPeople,5);
  const selected=rooms.findRoom(rows,p);assert.equal(selected,casino[0]);
  const entered=rooms.enterRoomPayload(selected,p,{});
  assert.equal(entered.gameRoomConfigId,3110);assert.equal(entered.playMode,1);assert.equal(entered.key,p.key);
});
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
  assert.equal(payload.playMode, 0);
  assert.equal(payload.smallBlind, 10);
});

test("hundred rooms keep hundredDomain", () => {
  const row = { game_type: 50, room_type: 50, game_room_config_id: 1, play_mode: 1, room_index: 0, small_blind: 0, big_blind: 0, force_show_card: 0 };
  const payload = rooms.enterRoomPayload(row, { roomType: 50 }, { game_server: "127.0.0.1:11041", hundred_server: "127.0.0.1:11041" });
  assert.equal(payload.hundredDomain, "127.0.0.1:11041");
});

test("ordinary games retain a separate hundred endpoint and fall back to the shared server", () => {
  for (const roomType of [19, 25, 58, 61, 101]) {
    const row = { room_type: roomType, game_room_config_id: 70 };
    assert.equal(rooms.enterRoomPayload(row, {}, { game_server: "room.example:443",
      hundred_server: "hundred.example:443" }).hundredDomain, "hundred.example:443");
    assert.equal(rooms.enterRoomPayload(row, {}, { game_server: "room.example:443" }).hundredDomain, "room.example:443");
  }
});

test("dev public ws host rewrites lobby.localhost to www.localhost", () => {
  const host = publicWsHost(
    { headers: { host: "lobby.localhost:11042" } },
    { game_server: "127.0.0.1:11041" },
    "dev",
  );
  assert.equal(host, "www.localhost:11042");
  assert.equal(publicHundredWsHost({ headers: { host: "lobby.localhost:11042" } }, {}, "dev"),
    "hundred.localhost:11042");
});
