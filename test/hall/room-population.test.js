import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createRoomPopulation, roomEntryAmount } from "../../hall/src/room-population.js";
import { createApp } from "../../hall/src/create-app.js";

const midnight = Date.parse("2026-10-24T00:00:00+08:00");
const at = (hour) => midnight + hour * 3600_000;
const row = { game_type: 19 };
const room = { carryMin: 500, roomType: 19, totalPeople: 0 };

test("all daily segments follow Shanghai time and meet continuously at midnight", async () => {
  const population = await createRoomPopulation({ randomAmplitude: 0, minPeople: 0, maxPeople: 100 });
  const counts = Array.from({ length: 25 }, (_, hour) => population.decorate(room, row, at(hour)).totalPeople);
  assert.equal(counts[0], counts[24]);
  for (const [start, end, direction] of [[0, 3, -1], [6, 12, 1], [12, 14, -1], [14, 24, 1]]) {
    for (let hour = start + 1; hour <= end; hour++) {
      assert.ok((counts[hour] - counts[hour - 1]) * direction > 0, "hour " + hour);
    }
  }
  assert.equal(counts[3], Math.min(...counts));
  assert.deepEqual(counts.slice(3, 7), Array(4).fill(counts[3]));
  assert.ok(Math.abs(population.decorate(room, row, at(24) - 5000).totalPeople - counts[24]) <= 1);
  const utc = await createRoomPopulation({ randomAmplitude: 0, timeZone: "UTC" });
  const shanghai = await createRoomPopulation({ randomAmplitude: 0 });
  assert.equal(utc.decorate(room, row, at(12) + 8 * 3600_000).totalPeople,
    shanghai.decorate(room, row, at(12)).totalPeople);
});

test("entry amount reduces population throughout the day for every game type", async () => {
  const population = await createRoomPopulation();
  for (const gameType of [19, 21, 1000, 1002, 1004, 99999]) {
    for (let hour = 0; hour < 24; hour += 0.5) {
      const counts = [100, 500, 5000, 30000, 100000000].map(carryMin =>
        population.decorate({ ...room, carryMin }, { game_type: gameType }, at(hour)).totalPeople);
      assert.ok(counts.every(Number.isSafeInteger));
      assert.ok(counts.every(count => count >= 8 && count <= 100));
      assert.ok(counts.every((count, i) => i === 0 || count < counts[i - 1]), JSON.stringify(counts));
    }
  }
});

test("minimum stake supports games without carryMin and malformed amounts remain finite", async () => {
  assert.equal(roomEntryAmount({ carryMin: "500", hundredMinBet: 10 }), 500);
  assert.equal(roomEntryAmount({ carryMin: 0, hundredMinBet: 100 }), 100);
  assert.equal(roomEntryAmount({ carryMin: 0 }, { hundred_min_bet: 200 }), 200);
  assert.equal(roomEntryAmount({ carryMin: 0, ante: 300 }), 300);
  assert.equal(roomEntryAmount({ initialBet: 400 }), 400);
  assert.equal(roomEntryAmount({ bigBlind: 200, smallBlind: 100 }), 200);
  assert.equal(roomEntryAmount({ smallBlind: 100 }), 100);
  assert.equal(roomEntryAmount({ carryMin: -1, hundredMinBet: "bad", bigBlind: Infinity }), 0);
  const population = await createRoomPopulation();
  for (const carryMin of [undefined, null, "NaN", NaN, Infinity, -1, "", {}, true]) {
    assert.ok(Number.isSafeInteger(population.decorate({ carryMin }, row, at(12)).totalPeople));
  }
});

test("random variation is smooth, request-independent and survives hot reload", async () => {
  const first = await createRoomPopulation({}, "before");
  const next = await createRoomPopulation({}, "after");
  const start = at(4);
  const counts = [];
  for (let i = 0; i < 120; i++) {
    const time = start + i * 5000;
    const count = first.decorate(room, row, time).totalPeople;
    counts.push(count);
    assert.equal(first.decorate(room, row, time + 4999).totalPeople, count);
    assert.equal(next.decorate(room, row, time).totalPeople, count);
    for (let refresh = 0; refresh < 10; refresh++) assert.equal(first.decorate(room, row, time).totalPeople, count);
  }
  assert.ok(new Set(counts).size > 1);
  assert.ok(counts.filter((count, i) => i && count !== counts[i - 1]).length > 30);
  assert.ok(counts.every((count, i) => !i || Math.abs(count - counts[i - 1]) <= 15));
  const alternate = await createRoomPopulation({ seed: "other" });
  assert.notDeepEqual(counts, counts.map((_, i) => alternate.decorate(room, row, start + i * 5000).totalPeople));
});

test("range, entry decay and each time-period amplitude are configurable", async () => {
  const baseConfig = { randomAmplitude: 0, minPeople: 0, maxPeople: 100 };
  const base = await createRoomPopulation(baseConfig);
  const lowerPeak = await createRoomPopulation({ ...baseConfig, activity: { noon: 0.50 } });
  assert.ok(lowerPeak.decorate(room, row, at(12)).totalPeople < base.decorate(room, row, at(12)).totalPeople);
  const shallow = await createRoomPopulation({ ...baseConfig, entryDecay: 0.2 });
  const steep = await createRoomPopulation({ ...baseConfig, entryDecay: 1 });
  assert.ok(shallow.decorate(room, row, at(12)).totalPeople > steep.decorate(room, row, at(12)).totalPeople);
  const reference = await createRoomPopulation({ ...baseConfig, entryReference: 5000 });
  assert.ok(reference.decorate(room, row, at(12)).totalPeople > base.decorate(room, row, at(12)).totalPeople);
  const fixed = await createRoomPopulation({ minPeople: 100, maxPeople: 100 });
  for (let hour = 0; hour < 24; hour++) assert.equal(fixed.decorate(room, row, at(hour)).totalPeople, 100);
  const wider = await createRoomPopulation({ ...baseConfig, randomAmplitude: 0.2 });
  const baseline = base.decorate(room, row, at(4)).totalPeople;
  const noisy = wider.decorate(room, row, at(4)).totalPeople;
  assert.ok(Math.abs(noisy - baseline) <= baseline * 0.2 + 1);
  assert.notEqual(noisy, baseline);
});

test("high-entry rooms retain daily trends and visible variation within short refresh windows", async () => {
  const population = await createRoomPopulation();
  const trend = await createRoomPopulation({ randomAmplitude: 0 });
  for (const gameType of [19, 21, 1000, 1002, 1004, 99999]) {
    for (const carryMin of [500, 5000, 30000, 100000000]) {
      const source = { game_type: gameType };
      const target = { carryMin };
      const low = trend.decorate(target, source, at(4)).totalPeople;
      const noon = trend.decorate(target, source, at(12)).totalPeople;
      const afternoon = trend.decorate(target, source, at(14)).totalPeople;
      const peak = trend.decorate(target, source, at(24)).totalPeople;
      assert.ok(low < afternoon && afternoon < noon && noon < peak, JSON.stringify({ gameType, carryMin, low, noon, afternoon, peak }));
      for (const hour of [0, 4, 10, 13, 20]) {
        const counts = Array.from({ length: 24 }, (_, i) => population.decorate(target, source, at(hour) + i * 5000).totalPeople);
        assert.ok(new Set(counts).size > 1, JSON.stringify({ gameType, carryMin, hour, counts }));
        assert.ok(counts.every(count => count >= 8 && count <= 100));
      }
    }
  }
  const fixed = await createRoomPopulation({ minPeople: 42, maxPeople: 42 });
  assert.equal(fixed.decorate({ carryMin: 100000000 }, row, at(4)).totalPeople, 42);
  const legacy = await createRoomPopulation({ minimumActivityShare: 0, randomAmplitude: 0 });
  assert.equal(legacy.decorate({ carryMin: 100000000 }, row, at(4)).totalPeople, 8);
});

test("invalid settings are normalized without NaN or inverted time trends", async () => {
  const population = await createRoomPopulation({
    timeZone: "invalid/time-zone", refreshSeconds: -1, randomPeriodSeconds: 0,
    minPeople: "100", maxPeople: "bad", entryReference: 0, entryDecay: Infinity,
    randomAmplitude: -5, activity: { low: 0.8, noon: 0.2, afternoon: 0.9 },
  });
  assert.equal(population.settings.timeZone, "Asia/Shanghai");
  assert.equal(population.settings.refreshSeconds, 1);
  assert.equal(population.settings.randomPeriodSeconds, 1);
  assert.equal(population.settings.activity.low, population.settings.activity.noon);
  assert.equal(population.settings.activity.afternoon, population.settings.activity.noon);
  for (let hour = 0; hour < 24; hour++) {
    const count = population.decorate(room, row, at(hour)).totalPeople;
    assert.ok(Number.isSafeInteger(count));
    assert.equal(count, 100);
  }
});

test("each room stays within 100 even at peak activity with noise and oversized overrides", async () => {
  for (const settings of [{}, { maxPeople: 1200, randomAmplitude: 0.5 }, { minPeople: 1000, maxPeople: 10000 }]) {
    const population = await createRoomPopulation(settings);
    assert.equal(population.settings.maxPeople, 100);
    assert.ok(population.settings.minPeople <= 100);
    for (const gameType of [19, 21, 1000, 1002, 1004, 99999]) {
      for (let minute = 0; minute < 1440; minute += 5) {
        const count = population.decorate({ carryMin: 0 }, { game_type: gameType }, at(minute / 60)).totalPeople;
        assert.ok(Number.isSafeInteger(count) && count >= 0 && count <= 100);
      }
    }
  }
});

test("disabled mode retains real data; decoration does not mutate configuration or room state", async () => {
  const original = Object.freeze({ ...room, totalPeople: 7, arbitraryProtocolField: "preserved" });
  const source = Object.freeze({ ...row, carry_min: 500 });
  const disabled = await createRoomPopulation({ enabled: false });
  assert.equal(disabled.decorate(original, source, at(12)), original);
  const enabled = await createRoomPopulation();
  const output = enabled.decorate(original, source, at(12));
  assert.equal(original.totalPeople, 7);
  assert.equal(output.arbitraryProtocolField, "preserved");
  assert.deepEqual({ ...output, totalPeople: 7 }, original);
});

test("op 38 applies common counts to every game without waking or allocating rooms", async (t) => {
  const gameTypes = [19, 21, 1000, 1002, 1004, 54321];
  const roomTypes = [19, 25, 18, 58, 61, 54321];
  const rows = gameTypes.flatMap((game_type, index) => [100, 5000, 100000].map((carry_min, rank) => ({
    game_type, room_type: roomTypes[index], game_room_config_id: index * 100 + rank,
    state: 1, play_mode: 0, carry_min, sort_index: rank, payload: '{"unchangedField":"ok"}',
  })));
  const before = JSON.stringify(rows);
  let gameServerRequests = 0;
  const fakeGameServer = http.createServer((_req, res) => { gameServerRequests++; res.end(); });
  const roomQueries = [];
  const sockets = new WebSocketServer({ server: fakeGameServer });
  sockets.on('connection', socket => socket.on('message', raw => {
    const query = JSON.parse(raw.toString());
    roomQueries.push(query);
    socket.send(JSON.stringify({ type: 'room-pool-result', code: 200, data: [] }));
  }));
  await new Promise(resolve => fakeGameServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => fakeGameServer.close(resolve)));
  const runtime = {
    env: "prod", hotVersion: "population-http", config: { game_server: "127.0.0.1:" + fakeGameServer.address().port },
    log: { error() {} }, matchStore: { listMatches: () => [] }, roomStore: { list: () => rows },
  };
  let app = await createApp(runtime);
  const server = http.createServer((req, res) => app(req, res));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const query = async gameType => {
    const params = new URLSearchParams({ op: "38", gameType, userId: "10001", token: "dev" });
    const body = await (await fetch("http://127.0.0.1:" + server.address().port + "/api/internal/v1/do?" + params)).json();
    assert.equal(body.msgCode, 200);
    return body.data[0].roomInfoData;
  };
  for (const type of gameTypes) {
    const list = await query(type);
    assert.equal(list.length, 3);
    assert.ok(list.every(item => Number.isSafeInteger(item.totalPeople) && item.totalPeople > 0 && item.totalPeople <= 100));
    assert.ok(list[0].totalPeople > list[1].totalPeople && list[1].totalPeople > list[2].totalPeople);
    assert.ok(list.every(item => item.unchangedField === "ok"));
  }
  assert.equal(gameServerRequests, 0, "population decoration needs no HTTP request");
  assert.equal(roomQueries.length, 2);
  assert.ok(roomQueries.every(query => query.type === 'room-pool' && query.action === 'hundred-list'),
    'hundred lists read public snapshots; never allocate or wake rooms');
  assert.equal(JSON.stringify(rows), before);
  runtime.config.room_population = { minPeople: 42, maxPeople: 42 };
  runtime.hotVersion = "population-http-hot";
  app = await createApp(runtime);
  assert.ok((await query(54321)).every(item => item.totalPeople === 42), "new app picks up common configuration");
  runtime.config.room_population = { minPeople: 123, maxPeople: 123 };
  runtime.hotVersion = "population-http-cap";
  app = await createApp(runtime);
  for (const type of gameTypes) {
    assert.ok((await query(type)).every(item => item.totalPeople === 100), "overrides cannot exceed the common ceiling");
  }
});
