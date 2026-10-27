import { rel } from "../rel.js";

const GAME_ENTRIES = [
  "./holdem/index.js",
  "./baccarat/index.js",
  "./ggl-mjhl/index.js",
  "./ggl-queen/index.js",
  "./zjh/index.js",
  "./niuniu/index.js",
];

export async function loadGames(version) {
  const mods = await Promise.all(GAME_ENTRIES.map((spec) => rel(import.meta.url, spec, version)));
  const list = mods.map((mod) => mod.default);
  const byRoomType = new Map();
  for (const game of list) {
    for (const roomType of game.roomTypes) {
      byRoomType.set(Number(roomType), game);
    }
  }
  return { list, byRoomType };
}

export function gameOf(games, roomType) {
  return games.byRoomType.get(Number(roomType)) || null;
}
