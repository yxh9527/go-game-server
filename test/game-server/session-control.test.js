import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../game-server/src/registry.js';
import { createWallet } from '../../game-server/src/wallet/index.js';
import { encodeFrame, decodeFrame } from '../../game-server/src/codec.js';
import { SEND, PUSH } from '../../game-server/src/messages.js';
import { seedRooms } from '../../cache/rpc/seed.js';
import { createGameSessionStore,createInMemoryGameSessionBackend } from '../../shared/rpc/game-session-store.js';
import { createSessionControl } from '../../game-server/src/session-control.js';

function deferred() {
  let resolve;
  return { promise: new Promise(r => { resolve = r; }), resolve: (...args) => resolve(...args) };
}
async function fixture(distributed=false) {
  const runtime = { hotVersion: 'login-guard', registry: createRegistry(), configs: seedRooms(), findConfig,
    wallet: createWallet({ mode: 'local', local_balance: 10000 }),
    gateway: { validateToken: async token => token !== 'invalid', getLoginData: async () => ({ agentId: 9 }) },
    log: { info() {}, error() {} } };
  if(distributed)runtime.bus={gameSessions:createGameSessionStore({instanceId:'session-regression'})};
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

test('all normal seat-game native auxiliary logins preserve the joined main connection locally and across coordination',async()=>{
 for(const distributed of [false,true])for(const roomType of [19,24,25,26,27,28,30,31,32]){
  const f=await fixture(distributed),main=f.socket(),aux=f.socket();
  const cfg=f.runtime.configs.find(row=>Number(row.room_type)===roomType&&Number(row.state??1)===1);
  assert.ok(cfg,'seed for '+roomType);
  const login={...credentials,roomId:Number(cfg.game_room_config_id)*10000,openHundredGame:false};
  await main.send(SEND.ROOM_LOGIN,login);
  await main.send(SEND.SEND_JOIN_ROOM,{roomType,roomId:login.roomId});
  const primary=f.runtime.registry.session(main.ws);assert.equal(primary.inRoom,true,'joined '+roomType);
  await aux.send(SEND.ROOM_LOGIN,login);
  assert.equal(main.ws.readyState,1,'auxiliary must not kick primary: '+roomType+' distributed='+distributed);
  assert.equal(main.frames.some(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT),false);
  assert.equal(f.runtime.registry.session(aux.ws)?.loginRole,'hundred');
  if(distributed){
   assert.equal(await f.runtime.bus.gameSessions.verify(primary),true);
   f.runtime.bus.gameSessions.coordinationVersion='native-sockets-2';
   await f.reload();
   assert.equal(await f.runtime.bus.gameSessions.verify(primary),true,'hot update preserves the resident owner');
   assert.equal(main.ws.readyState,1);assert.equal(aux.ws.readyState,1);
  }
 }
});

test('native initial login keeps its automatic hundred socket when both 1105 payloads omit the game identity and disable the overlay',async()=>{
 const f=await fixture(true),main=f.socket(),overlay=f.socket();
 const login={...credentials,openHundredGame:false};
 await join(main,login);const primary=f.runtime.registry.session(main.ws);
 await overlay.send(SEND.ROOM_LOGIN,login);
 assert.equal(main.ws.readyState,1,'initial RoomSocket-222 must not kick RoomSocket-111');
 assert.equal(overlay.ws.readyState,1);assert.equal(f.runtime.registry.session(overlay.ws)?.loginRole,'hundred');
 assert.equal(f.runtime.registry.session(overlay.ws)?.loginId,primary.loginId);
 assert.equal(main.frames.filter(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT).length,0);
 await f.handler.onClose(overlay.ws);
 await main.send(SEND.PING);
 assert.equal(main.ws.readyState,1,'closing the hundred socket cannot revoke the primary lease');
 assert.equal(await f.runtime.bus.gameSessions.verify(primary),true);
 const reopened=f.socket();await reopened.send(SEND.ROOM_LOGIN,login);
 assert.equal(f.runtime.registry.session(reopened.ws)?.loginRole,'hundred');assert.equal(main.ws.readyState,1);
 await f.reload();await main.send(SEND.PING);assert.equal(main.ws.readyState,1);
});

test('completed disconnected accounts release local login fences while pending authentication remains fenced',async()=>{
  const f=await fixture();
  for(let uid=880001;uid<880021;uid++){
    const socket=f.socket();await socket.send(SEND.ROOM_LOGIN,{...credentials,userId:uid});
    await f.handler.onClose(socket.ws);
  }
  assert.equal(f.runtime.sessionControl.latest.size,0);assert.equal(f.runtime.sessionControl.latestKeysByUser.size,0);
  assert.equal(f.runtime.sessionControl.pendingLogins.size,0);
  const slow=f.socket(),fast=f.socket(),started=deferred(),finish=deferred();
  f.runtime.gateway.validateToken=async token=>{if(token==='slow-fence'){started.resolve();await finish.promise;}return true;};
  const waiting=slow.send(SEND.ROOM_LOGIN,{...credentials,userToken:'slow-fence'});await started.promise;
  await fast.send(SEND.ROOM_LOGIN,credentials);await f.handler.onClose(fast.ws);
  assert.equal(f.runtime.sessionControl.latest.size,1,'closing a newer login cannot release the fence of an older pending attempt');
  finish.resolve();await waiting;
  assert.equal(f.runtime.registry.session(slow.ws),null);assert.equal(slow.ws.readyState,3);
  assert.equal(f.runtime.sessionControl.latest.size,0);assert.equal(f.runtime.sessionControl.pendingLogins.size,0);
});

test('normal primary teardown identifies auxiliary retirement separately from account replacement',async()=>{
  const f=await fixture(true),main=f.socket(),aux=f.socket();
  await join(main);await aux.send(SEND.ROOM_LOGIN,credentials);
  assert.equal(f.runtime.registry.session(aux.ws).loginRole,'hundred');
  await f.handler.onClose(main.ws);await f.handler.onClose(aux.ws);
  assert.equal(aux.ws.readyState,3);assert.equal(f.runtime.registry.session(aux.ws),null);
  assert.deepEqual(aux.frames.find(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT).payload,{reason:'primary-closed',auxiliary:true});
  const old=f.socket(),other=f.socket();await join(old);
  await other.send(SEND.ROOM_LOGIN,{...credentials,userToken:'other-device',deviceId:'other-device'});
  assert.equal(old.frames.find(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT).payload,null,'real replacements retain the original kick-out response');
});

test('late marked auxiliaries can never create or replace a primary session',async()=>{
  for(const distributed of [false,true]){
    const f=await fixture(distributed),main=f.socket(),aux=f.socket();
    await join(main);
    const owner=f.runtime.registry.session(main.ws),attempt=owner.loginAttempt;
    await aux.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(main.ws.readyState,1);assert.equal(f.runtime.registry.session(aux.ws).loginRole,'hundred');
    if(distributed)assert.equal(f.runtime.bus.gameSessions.memoryBackend.sequences.get('attempt:'+credentials.userId),attempt,'an auxiliary does not fence an authenticating primary');
    await f.handler.onClose(main.ws);await f.handler.onClose(aux.ws);
    const late=f.socket();await late.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(f.runtime.registry.session(late.ws),null);assert.equal(late.ws.readyState,3);
    assert.deepEqual(late.frames.find(r=>r.msgid===PUSH.USER_LOGIN_KICKOUT).payload,{reason:'primary-closed',auxiliary:true});
    const next=f.socket();await join(next,{...credentials,userToken:'new-token',deviceId:'new-device'});
    const stale=f.socket();await stale.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(next.ws.readyState,1);assert.equal(f.runtime.registry.session(next.ws).loginRole,'primary');
    assert.equal(f.runtime.registry.session(stale.ws),null);
  }
});

test('premature auxiliaries cannot fence a primary still authenticating',async()=>{
  for(const distributed of [false,true]){
    const f=await fixture(distributed),main=f.socket(),aux=f.socket(),started=deferred(),finish=deferred();
    let first=true;
    f.runtime.gateway.validateToken=async()=>{if(first){first=false;started.resolve();await finish.promise;}return true;};
    const pending=main.send(SEND.ROOM_LOGIN,credentials);await started.promise;
    await aux.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(aux.ws.readyState,3);assert.equal(f.runtime.registry.session(aux.ws),null);
    finish.resolve();await pending;
    assert.equal(main.ws.readyState,1);assert.equal(f.runtime.registry.session(main.ws)?.loginRole,'primary');
  }
});

test('marked auxiliaries may pair during the authenticated pre-join window, but never after explicit room exit',async()=>{
  for(const distributed of [false,true]){
    const f=await fixture(distributed),main=f.socket(),aux=f.socket();
    await main.send(SEND.ROOM_LOGIN,credentials);
    assert.equal(f.runtime.registry.session(main.ws).inRoom,false);
    await aux.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(f.runtime.registry.session(aux.ws)?.loginRole,'hundred');
    assert.equal(main.ws.readyState,1);
    await main.send(SEND.SEND_JOIN_ROOM,{roomId:credentials.roomId,roomType:19});
    await main.send(SEND.SEND_LEVEL_OUT);
    await f.handler.onClose(aux.ws);
    const late=f.socket();await late.send(SEND.ROOM_LOGIN,{...credentials,auxiliaryOnly:true});
    assert.equal(f.runtime.registry.session(late.ws),null);assert.equal(main.ws.readyState,1);
  }
});

test('hot update upgrades the old private dev coordination store without kicking its valid primary and auxiliary',async()=>{
 const f=await fixture(true),main=f.socket(),overlay=f.socket();
 const login={...credentials,openHundredGame:false};
 await join(main,login);await main.send(SEND.SEND_SITDOWN,{position:0});await main.send(SEND.SEND_CARRY_SCORE,{carryIn:5});
 await overlay.send(SEND.ROOM_LOGIN,login);
 const primary=f.runtime.registry.session(main.ws),secondary=f.runtime.registry.session(overlay.ws),store=f.runtime.bus.gameSessions;
 const snapshot={wallet:primary.wallet,carry:primary.carryAmount,loginId:primary.loginId};
 delete store.memoryBackend;delete store.coordinationVersion;
 await f.reload();
 assert.notEqual(f.runtime.bus.gameSessions,store);assert.equal(f.runtime.registry.session(main.ws),primary);
 assert.equal(f.runtime.registry.session(overlay.ws),secondary);
 assert.equal(await f.runtime.bus.gameSessions.verify(primary),true);assert.equal(await f.runtime.bus.gameSessions.verify(secondary),true);
 assert.equal(primary.wallet,snapshot.wallet);assert.equal(primary.carryAmount,snapshot.carry);assert.equal(primary.loginId,snapshot.loginId);
 await main.send(SEND.PING);await overlay.send(SEND.PING);
 assert.equal(main.ws.readyState,1);assert.equal(overlay.ws.readyState,1);
 assert.equal(main.frames.some(frame=>frame.msgid===PUSH.USER_LOGIN_KICKOUT),false);
 const next=f.socket();await next.send(SEND.ROOM_LOGIN,{...credentials,userToken:'replacement',deviceId:'replacement'});
 assert.equal(main.ws.readyState,3);assert.equal(overlay.ws.readyState,3,'new store events reach the current hot handler');
});

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
  const leaving = f.handler.onClose(old.ws);
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
  assert.ok(main.frames.some(frame => frame.msgid === 9999 && /下局站起/.test(frame.payload.errorMsg)));
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
  await main.send(SEND.SEND_NEXT_ROUND_STANDUP);
  await main.send(SEND.SEND_LEVEL_OUT);
  assert.equal(session.wallet, 6000);
  assert.equal(session.carryAmount, 0);
  assert.equal(session.availableBalance, 6000);
});

test('separate game-server instances share session fencing, cross-instance eviction, and pair the hundred socket',async()=>{
 const backend=createInMemoryGameSessionBackend();
 function node(){
  const runtime={registry:createRegistry(),bus:{gameSessions:createGameSessionStore({backend,instanceId:Math.random().toString(36)})},
    log:{info(){},error(){}}};
  const control=createSessionControl(runtime,{send:ws=>{ws.kicks++},close:async ws=>{runtime.registry.drop(ws);ws.close();},kickId:9000});
  return{runtime,control,async login(ws,token,{identity=token,allowPair=false,roomId=700000}={}){
    const session={userId:72,agentId:9,roomId,gameId:'holdem',roomType:19,inRoom:false,authenticated:true,
      loginId:identity+'-'+ws.socketId,socketId:ws.socketId,loginIdentity:identity,loginAttempt:await this.control.beginAttempt(72)};
    const order=await this.control.begin(ws,order=>this.control.accept(ws,session,order,{openHundredGame:allowPair}));
    return runtime.registry.session(ws)||null;
  }};
 }
 const a=node(),b=node();
 const primarySocket={readyState:1,kicks:0,close(){this.readyState=3;}};primarySocket.socketId='primary';
 const primary=await a.login(primarySocket,'same-token',{identity:'same'});primary.roomType=19;primary.inRoom=true;primary.roomId=700001;
 await a.control.updateRoom(primary,{roomType:19});
 const overlaySocket={readyState:1,kicks:0,close(){this.readyState=3;}};overlaySocket.socketId='overlay';
 const overlay=await b.login(overlaySocket,'same-token',{identity:'same',allowPair:true,roomId:700001});
 assert.equal(overlay.loginRole,'hundred');assert.equal(primarySocket.readyState,1);assert.equal(await a.control.verify(primarySocket,primary),true);
 await b.control.promote(overlaySocket,overlay);
 assert.equal(overlay.loginRole,'primary');assert.equal(overlaySocket.readyState,1);assert.equal(primarySocket.readyState,3);
 assert.equal(await b.control.verify(overlaySocket,overlay),true,'promoting the hundred socket transfers the distributed lease');
 const replacement={readyState:1,kicks:0,close(){this.readyState=3;}};replacement.socketId='replacement';
 const replacementSession=await b.login(replacement,'token-b',{identity:'different',roomId:700002});
 assert.ok(replacementSession);assert.equal(primarySocket.readyState,3);assert.equal(overlaySocket.readyState,3);
 assert.equal(primarySocket.kicks,1);assert.equal(overlaySocket.kicks,1);
 assert.equal(await a.control.verify(primarySocket,primary),false);
 await a.control.release(primary);
 assert.equal(await b.control.verify(replacement,replacementSession),true,'late old close cannot release the replacement lease');
});
