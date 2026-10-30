import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRoomStatusView, hallCardImagePath } from '../../hall/src/room-status-view.js';
import { loadGames, gameOf } from '../../game-server/src/games/catalog.js';
import { createRegistry } from '../../game-server/src/registry.js';
import { listHundredLobbyRooms, hundredLobbySnapshot } from '../../game-server/src/core/hundred-lobby.js';
import { seedRooms } from '../../cache/rpc/seed.js';

test('public card images preserve face zero and use the native back for hidden cards', () => {
  assert.equal(hallCardImagePath(0), '/l01/img/cards/small/0.webp');
  assert.equal(hallCardImagePath(16), '/l01/img/cards/small/16.webp');
  assert.equal(hallCardImagePath(-1), '/l01/img/cards/small/card-back-blue.png');
  assert.equal(hallCardImagePath(null), undefined);
  assert.equal(hallCardImagePath(undefined), undefined);
});

test('status clock handles server skew, refresh, expiry and custom game phases', () => {
  let now = 1000, state, ref, mounted = false;
  const timers = new Set(), effects = [];
  const React = {
    useState: initial => [state ??= initial(), value => { state = value; }],
    useRef: value => ref ??= { current: value },
    useEffect: effect => { if (!mounted) effects.push(effect); },
    createElement: (type, props, children) => ({ type, props, children }),
  };
  const RoomStatus = vm.runInNewContext('(' + createRoomStatusView.toString() + ')(React)', {
    React, Date: { now: () => now },
    window: { setInterval(fn) { timers.add(fn); return fn; }, clearInterval(fn) { timers.delete(fn); } },
  });
  let room = { roomId: 1, roomType: 53, gameStatus: 2, gameStatusStartTime: 999000,
    gameStatusDuration: 10000, serverNow: 999000 };
  assert.equal(RoomStatus({ room }).children, '下注中 10s');
  const cleanup = effects[0](); mounted = true;
  assert.equal(timers.size, 1);
  now = 3500; for (const tick of timers) tick();
  assert.equal(RoomStatus({ room }).children, '下注中 8s');
  room = { ...room, gameStatusDuration: 5000 };
  assert.equal(RoomStatus({ room }).children, '下注中 5s');
  now += 6000; for (const tick of timers) tick();
  assert.equal(RoomStatus({ room }).children, '状态同步中');
  assert.equal(RoomStatus({ room: { ...room, gameStatus: 0, gameStatusDuration: 0 } }).children, '等待开局');
  for (const [roomType, gameStatus, text] of [[53,4,'开奖中'],[53,6,'结算中'],[53,10,'路单统计'],
    [50,5,'结算中'],[50,6,'路单统计'],[58,3,'停止下注'],[58,6,'结算中'],
    [60,5,'比牌中'],[60,6,'结算中'],[60,8,'洗牌中']]) {
    assert.equal(RoomStatus({ room: { ...room, roomType, gameStatus, gameStatusDuration: 5000 } }).children, text + ' 5s');
  }
  assert.equal(RoomStatus({ room: { roomType: 53, gameStatus: 2 } }).children, '状态同步中');
  cleanup(); assert.equal(timers.size, 0);
});

test('static chunks render shared badges and visible cards for every hundred game', async () => {
  const definitions = {}, cache = {};
  const react = { useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect() {}, useRef: value => ({ current: value }), createElement: (type, props, children) => ({ type, props: { ...props, children } }) };
  const jsx = (type, props) => ({ type, props });
  Object.assign(cache, { 5868: react, 7876: { jsx, jsxs: jsx }, 6567: { OY() {} }, 4988: { ok: () => ({}) } });
  const chunks = [];
  for (const file of ['434-da255fd00b51666b.js','553.bbe3bc413ea4869f.js','345.9de70229d91b0fcc.js',
    '194.814b8c8dec766fa3.js','726.ed0f4d2a88a2c3e3.js']) {
    vm.runInNewContext(fs.readFileSync(new URL('../../static/hall/_next/static/chunks/' + file, import.meta.url), 'utf8'),
      { self: { webpackChunk_N_E: chunks } });
  }
  for (const chunk of chunks) Object.assign(definitions, chunk[1]);
  const require = id => {
    if (Object.hasOwn(cache, id)) return cache[id];
    const module = { exports: {} }; cache[id] = module.exports;
    assert.ok(definitions[id], 'static dependency exists: ' + id);
    definitions[id](module, module.exports, require); return cache[id] = module.exports;
  };
  require.r = () => {};
  require.d = (target, getters) => { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }); };
  require.n = value => () => value;
  const games = await loadGames('hundred-hall-view'), rows = seedRooms();
  const runtime = { configs: rows, registry: createRegistry() };
  const cards = listHundredLobbyRooms(runtime, type => gameOf(games, type), 1);
  function render(element, elements = []) {
    if (Array.isArray(element)) { for (const child of element) render(child, elements); return elements; }
    if (!element || typeof element !== 'object') return elements;
    if (typeof element.type === 'function') return render(element.type(element.props), elements);
    elements.push(element); render(element.props?.children, elements); return elements;
  }
  for (const card of cards) {
    const module = card.roomType >= 53 && card.roomType <= 57 ? 553 : card.roomType === 58 ? 6194 : 7726;
    const room = { ...card, extendInfo: JSON.parse(card.extendInfo) };
    const elements = render(require(module).default({ roomInfoData: [room] }));
    assert.equal(elements.filter(el => el.props?.['data-room-status']).length, 1);
    if (module === 553) assert.equal(elements.filter(el => el.type === 'i').length, 48, 'both wheel tracks render');
  }
  for (const row of rows.filter(row => [50,51,52,60,62].includes(row.room_type))) {
    const game = gameOf(games, row.room_type), table = game.createTable(row.game_room_config_id * 10000, row.room_type, row);
    game.engine.beginRound({ broadcast() {} }, table, Date.now());
    for (const state of [2, game.engine.PHASE.SETTLING]) {
      table.state = state;
      const card = hundredLobbySnapshot(game, table);
      const elements = render(require(7726).default({ roomInfoData: [{ ...card, extendInfo: JSON.parse(card.extendInfo) }] }));
      assert.equal(elements.filter(el => el.props?.['data-room-status']).length, 1);
      assert.ok(elements.some(el => el.type === 'img' && /cards|1000\/62\/\-?\d+\.png/.test(el.props.src)),
        'actual visible cards render: roomType=' + row.room_type + ' state=' + state);
      const images = elements.filter(el => el.type === 'img' && el.props.src?.includes('/cards/small/'));
      assert.ok(images.every(el => !el.props.src.endsWith('/-1.webp')), 'hidden cards never request a numbered face');
      const extend = JSON.parse(card.extendInfo);
      if (row.room_type !== 62 && Object.values(extend.showdownPokers || {}).flat().includes(-1)) {
        assert.ok(images.some(el => el.props.src.endsWith('/card-back-blue.png')), 'hidden cards retain their back');
      }
    }
  }
});
