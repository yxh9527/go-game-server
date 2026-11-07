import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createWallet } from '../../game-server/src/wallet/index.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { SEND, PUSH } from '../../game-server/src/messages.js';
import { seedRooms } from '../../cache/rpc/seed.js';

function deferred() {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: (...args) => resolve(...args) };
}
async function fixture() {
  const runtime = { hotVersion: 'login-guard', registry: createRegistry(), configs: seedRooms(), findConfig,
    wallet: createWallet({ mode: 'local', local_balance: 10000 }),
    gateway: { validateToken: async token => token !== 'invalid', getLoginData: async () => ({ agentId: 9 }) },
    log: { info() {}, error() {} } };
  let handler = await createHandler(runtime);
  function socket() {
    const frames = [];
    const ws = { readyState: 1, send: raw => frames.push(decodeFrame(raw)), close() { this.readyState = 3; } };
    return { ws, frames, send: (id, data) => handler.onMessage(ws, encodeFrame(id, data)) };
  }
  return { runtime, socket, get handler() { return handler; }, async reload() {
    runtime.hotVersion += '-next'; handler = await createHandler(runtime);
  } };
}
const credentials = { userId: 72001, userToken: 'session-a', deviceId: 'device-a', roomId: 700000 };
async function join(s, login = credentials) {
  await s.send(SEND.ROOM_LOGIN, login);
  await s.send(SEND.SEND_JOIN_ROOM, { roomType: 19, roomId: login.roomId });
}

test('new login kicks the old login, refunds once, and late close cannot remove the replacement', async () => {
  const f = await fixture(), old = f.socket(), next = f.socket();
  await join(old);
  await old.send(SEND.SEND_SITDOWN, { position: 0 });
  await old.send(SEND.SEND_CARRY_SCORE, { carryIn: 5 });
  const previous = f.runtime.registry.session(old.ws);
  assert.equal(previous.wallet, 10000);
  assert.equal(previous.carryAmount, 500);
  await f.reload();
  await join(next, { ...credentials, userToken: 'session-b', deviceId: 'device-b' });
  const current = f.runtime.registry.session(next.ws);
  assert.equal(old.frames.filter(m => m.msgid === PUSH.USER_LOGIN_KICKOUT).length, 1);
  assert.equal(old.ws.readyState, 3);
  assert.equal(previous.authenticated, false);
  assert.equal(current.wallet, 10000);
  await Promise.all([f.handler.onClose(old.ws), old.send(SEND.SEND_STANDUP)]);
  assert.equal(f.runtime.registry.session(next.ws), current);
  assert.equal(current.wallet, 10000);
  assert.equal(f.runtime.registry.getTable(700000, 9, 'holdem').observers.filter(p => p.uid === credentials.userId).length, 1);
});

test('same-session primary and hundred socket coexist across hot update; new credentials kick both', async () => {
  const f = await fixture(), main = f.socket(), hundred = f.socket(), next = f.socket();
  const login = { ...credentials, openHundredGame: true };
  await join(main, login);
  await f.reload();
  await hundred.send(SEND.ROOM_LOGIN, login);
  await hundred.send(SEND.ENTER, { roomType: 50, playMode: 1 });
  assert.equal(f.runtime.registry.sessions.size, 2);
  assert.equal(f.runtime.registry.session(hundred.ws).loginRole, 'hundred');
  assert.equal(main.ws.readyState, 1);
  await next.send(SEND.ROOM_LOGIN, { ...login, userToken: 'new-session' });
  assert.equal(main.ws.readyState, 3);
  assert.equal(hundred.ws.readyState, 3);
  assert.equal(f.runtime.registry.sessions.size, 1);
});

test('opening the hundred overlay after a normal launch keeps its existing primary', async () => {
  const f = await fixture(), main = f.socket(), hundred = f.socket();
  await join(main, credentials);
  await hundred.send(SEND.ROOM_LOGIN, { ...credentials, currency: 'UNTRUSTED' });
  await hundred.send(SEND.ENTER, { roomType: 50, playMode: 1 });
  assert.equal(f.runtime.registry.session(hundred.ws).currency, 'CNY');
  assert.equal(main.ws.readyState, 1);
  assert.equal(f.runtime.registry.session(main.ws).inRoom, true);
  assert.equal(f.runtime.registry.session(hundred.ws).loginRole, 'hundred');
});

test('second normal join with the same token replaces the primary instead of gaining another seat', async () => {
  const f = await fixture(), main = f.socket(), next = f.socket();
  const login = { ...credentials, openHundredGame: true };
  await join(main, login);
  await next.send(SEND.ROOM_LOGIN, login);
  assert.equal(main.ws.readyState, 1, 'compatible 1105 alone allows native hundred overlay');
  await next.send(SEND.SEND_JOIN_ROOM, { roomType: 19, roomId: 700000 });
  assert.equal(main.ws.readyState, 3);
  assert.equal(f.runtime.registry.session(next.ws).loginRole, 'primary');
});

test('failed authentication never evicts the active login; repeated 1105 cannot reset funded state', async () => {
  const f = await fixture(), main = f.socket(), bad = f.socket();
  await join(main);
  await main.send(SEND.SEND_SITDOWN, { position: 0 });
  await main.send(SEND.SEND_CARRY_SCORE, { carryIn: 5 });
  const session = f.runtime.registry.session(main.ws);
  await bad.send(SEND.ROOM_LOGIN, { ...credentials, userToken: 'invalid' });
  assert.equal(main.ws.readyState, 1);
  await main.send(SEND.ROOM_LOGIN, { ...credentials, userId: 999 });
  assert.equal(f.runtime.registry.session(main.ws), session);
  assert.equal(session.wallet, 10000);
  assert.equal(session.carryAmount, 500);
  assert.equal(session.inRoom, true);
});

test('late authentication cannot replace a newer successful login or resurrect a closed socket', async () => {
  const f = await fixture(), slow = f.socket(), fast = f.socket(), closed = f.socket();
  const started = deferred(), finish = deferred();
  f.runtime.gateway.validateToken = async token => {
    if (token === 'slow') { started.resolve(); await finish.promise; }
    return true;
  };
  const pending = slow.send(SEND.ROOM_LOGIN, { ...credentials, userToken: 'slow' });
  await started.promise;
  await fast.send(SEND.ROOM_LOGIN, credentials);
  finish.resolve(); await pending;
  assert.equal(f.runtime.registry.session(slow.ws), null);
  assert.equal(slow.ws.readyState, 3);
  assert.equal(f.runtime.registry.session(fast.ws).authenticated, true);
  const closing = closed.send(SEND.ROOM_LOGIN, credentials);
  await f.handler.onClose(closed.ws);
  await closing;
  assert.equal(f.runtime.registry.session(closed.ws), null);
  assert.equal(f.runtime.registry.session(fast.ws).authenticated, true);
});

test('replacement login and duplicate close release carry once and await persistence across hot update', async () => {
  const f = await fixture(), old = f.socket(), next = f.socket();
  await join(old);
  await old.send(SEND.SEND_SITDOWN, { position: 0 });
  await old.send(SEND.SEND_CARRY_SCORE, { carryIn: 5 });
  const start = deferred(), finish = deferred();
  let saves = 0;
  f.runtime.wallet.credit = () => assert.fail('reservation release must never credit the wallet');
  f.runtime.wallet.persist = async () => { saves++; start.resolve(); await finish.promise; };
  const leaving = old.send(SEND.SEND_LEVEL_OUT);
  await start.promise;
  await f.reload();
  const replacing = next.send(SEND.ROOM_LOGIN, { ...credentials, userToken: 'session-b' });
  const closing = f.handler.onClose(old.ws);
  assert.equal(f.runtime.registry.session(next.ws), null);
  finish.resolve();
  await Promise.all([leaving, replacing, closing, f.handler.onClose(old.ws)]);
  assert.equal(saves, 1);
  assert.equal(f.runtime.registry.session(next.ws).wallet, 10000);
});

test('concurrent bets on multiple tables share the primary and hundred account balance', async () => {
  const f = await fixture(), main = f.socket(), hundred = f.socket();
  const login = { ...credentials, openHundredGame: true };
  await join(main, login);
  await hundred.send(SEND.ROOM_LOGIN, login);
  await hundred.send(SEND.MB_REG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 58 }], customData: 2 });
  const tables = f.runtime.registry.listAgentGameRooms(9, 'baccarat').slice(0, 2);
  assert.equal(tables.length, 2);
  await Promise.all(tables.map(table => hundred.send(SEND.MB_ROOM_BET_REQ, {
    roomType: 58, roomId: table.roomId, params: [{ areaId: 1, total: 6000 }] })));
  const replies = hundred.frames.filter(frame => frame.msgid === PUSH.MB_ROOM_BET_RES);
  assert.equal(replies.filter(frame => frame.payload.code === 0).length, 1);
  assert.equal(replies.filter(frame => frame.payload.code !== 0).length, 1);
  assert.equal(f.runtime.registry.session(main.ws).wallet, 4000);
  assert.equal(f.runtime.registry.session(hundred.ws).wallet, 4000);
  assert.equal(tables.reduce((sum, table) => sum + (table.playerBets.get(login.userId) || [])
    .reduce((total, bet) => total + bet.total, 0), 0), 6000);
});

test('cash entry is exclusive while native hundred and multi-slot discovery retain the funded primary', async () => {
  const f = await fixture(), main = f.socket(), hundred = f.socket();
  await join(main);
  await main.send(SEND.SEND_SITDOWN, { position: 0 });
  await main.send(SEND.SEND_CARRY_SCORE, { carryIn: 60 });
  const session = f.runtime.registry.session(main.ws);
  const oldRoom = session.roomId;
  assert.equal(session.wallet, 10000);
  assert.equal(session.carryAmount, 6000);
  const target = f.runtime.configs.find(row => Number(row.room_type) === 25);
  await main.send(SEND.SEND_JOIN_ROOM, { roomType: 25, roomId: Number(target.game_room_config_id) * 10000 });
  assert.equal(session.roomId, oldRoom);
  assert.ok(main.frames.some(frame => frame.msgid === 9999 && /带入/.test(frame.payload.errorMsg)));
  await hundred.send(SEND.ROOM_LOGIN, credentials);
  await hundred.send(SEND.ENTER, { roomType: 50, playMode: 1 });
  assert.equal(main.ws.readyState, 1);
  assert.equal(session.carryAmount, 6000);
  await hundred.send(SEND.MB_REG_ROOMS_REQ, { mulRoomTypeList: [{ roomType: 58 }, { roomType: 61 }], customData: 2 });
  const registered = hundred.frames.findLast(frame => frame.msgid === PUSH.MB_REGED_ROOM_INFOS).payload.roomInfos;
  assert.ok(registered.some(room => room.roomType === 58));
  assert.ok(registered.some(room => room.roomType === 61));
  const baccarat = registered.find(room => room.roomType === 58);
  await hundred.send(SEND.MB_ROOM_BET_REQ, { roomType: 58, roomId: baccarat.roomId, params: [{ areaId: 1, total: 5000 }] });
  assert.notEqual(hundred.frames.findLast(frame => frame.msgid === PUSH.MB_ROOM_BET_RES).payload.code, 0);
  assert.equal(session.wallet, 10000);
  await hundred.send(SEND.MB_ROOM_BET_REQ, { roomType: 58, roomId: baccarat.roomId, params: [{ areaId: 1, total: 4000 }] });
  assert.equal(hundred.frames.findLast(frame => frame.msgid === PUSH.MB_ROOM_BET_RES).payload.code, 0);
  assert.equal(session.wallet, 6000);
  assert.equal(session.carryAmount, 6000);
  assert.equal(session.availableBalance, 0);
  await main.send(SEND.SEND_LEVEL_OUT);
  assert.equal(session.wallet, 6000);
  assert.equal(session.carryAmount, 0);
  assert.equal(session.availableBalance, 6000);
});
