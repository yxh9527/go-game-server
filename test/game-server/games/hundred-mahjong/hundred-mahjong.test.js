import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { HundredMahjongGame } from '../../../../game-server/src/games/hundred-mahjong/HundredMahjongGame.js';
import * as cards from '../../../../game-server/src/games/hundred-mahjong/hand.js';
import * as engine from '../../../../game-server/src/games/hundred-mahjong/engine.js';
import { roomRules } from '../../../../game-server/src/games/hundred-mahjong/config.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../../game-server/src/codec.js';
import { SEND } from '../../../../game-server/src/messages.js';
const tiles = dots => dots.map(n => n === 0 ? 29 : n - 1);
function fixture() {
  const game = new HundredMahjongGame(), row = seedRooms().find(r => r.room_type === 62);
  const table = game.createTable(62010000, 62, row), session = { userId: 11, wallet: 1000000 }, messages = [];
  table.visitors.add(11); table.playerSessions.set(11, session);
  const io = { broadcast: (id, data) => messages.push({ id, data: structuredClone(data) }),
    sendUser: (uid, id, data) => messages.push({ uid, id, data: structuredClone(data) }), forEachPlayer: fn => fn(session) };
  const runtime = { wallet: { debit(s, n) { s.wallet -= n; return { ok: true }; }, credit(s, n) { s.wallet += n; return { ok: true }; } } };
  const ctx = { game, table, session, io, runtime, send: (id, data) => io.sendUser(11, id, data) };
  const start = () => { engine.beginRound(io, table, Date.now(), () => 0.42); table.state = 2; table.phaseEndsAt = Date.now() + 20000; };
  return { game, row, table, session, messages, io, ctx, start };
}
test('Mahjong uses the captured sole room and accepts its lobby/socket mode aliases', () => {
  assert.equal(roomRules().playMode, 1); assert.equal(roomRules({ play_mode: 0 }).playMode, 1);
  assert.throws(() => roomRules({ play_mode: 2 }), /Unsupported/);
  assert.equal(seedRooms().filter(r => r.room_type === 62).length, 1);
});
test('original help ranks white pairs, nine-to-one pairs, 2/8, then points and largest tile', () => {
  const ranked = [[0,0], ...Array.from({length:9},(_,i)=>[9-i,9-i]), [8,2],
    [9,0],[8,1],[7,2],[6,3],[5,4], [8,0],[7,1],[6,2],[5,3],
    [7,0],[9,8],[6,1],[5,2],[4,3], [6,0],[9,7],[5,1],[4,2],
    [5,0],[9,6],[8,7],[4,1],[3,2], [4,0],[9,5],[8,6],[3,1],
    [3,0],[9,4],[8,5],[7,6],[2,1], [2,0],[9,3],[8,4],[7,5],
    [1,0],[9,2],[8,3],[7,4],[6,5], [9,1],[7,3],[6,4]].map(tiles);
  assert.equal(ranked.length, 55); assert.equal(new Set(ranked.map(c=>c.slice().sort().join(','))).size,55);
  for(let i=0;i<ranked.length;i++) {
    assert.equal(cards.compare(ranked[i],ranked[i].slice().reverse()),0);
    for(let j=i+1;j<ranked.length;j++) assert.equal(cards.compare(ranked[i],ranked[j]),1,JSON.stringify([ranked[i],ranked[j]]));
  }
  assert.deepEqual(cards.showdownTypes({ banker:[3,8], player:[3,2] }),{banker:25,player:17});
  assert.deepEqual(cards.showdownTypes({ banker:[5,1], player:[3,7] }),{banker:15,player:27});
  for(const invalid of [[-1,2],[9,1],[10,1],[1],[NaN,2]])assert.throws(()=>cards.evaluate(invalid),/Invalid/);
});
test('all eleven bets follow original help; equal hands refund only banker/player', () => {
  const result=(p,b)=>cards.outcomes(tiles(p),tiles(b));
  assert.deepEqual(result([4,3],[4,2]).winningAreas,[1,7]);
  assert.deepEqual(result([4,1],[5,1]).winningAreas,[2,6]);
  assert.deepEqual(result([9,0],[9,0]).winningAreas,[3,8]);
  assert.deepEqual(result([9,0],[9,0]).tieAreas,[1,2]);
  assert.deepEqual(result([8,1],[7,2]).winningAreas,[1,10]);
  assert.deepEqual(result([8,8],[9,9]).winningAreas,[2,4,5,9]);
  assert.deepEqual(result([9,1],[7,3]).winningAreas,[1,11]);
  assert.deepEqual(result([8,2],[6,4]).winningAreas,[1], '2/8 is special, not double zero');
});
test('each of forty physical tiles occurs four times and only two public tiles feed exact prices', () => {
  const deck=cards.makeDeck(); assert.equal(deck.length,40);
  for(const c of cards.tileIds)assert.equal(deck.filter(x=>x===c).length,4);
  for(const p of cards.tileIds)for(const b of cards.tileIds){
    const dist=cards.conditionalOutcomes(p,b); assert.equal(dist.total,38*37);
    for(const id of cards.areaIds)assert.ok(dist.wins[id]+dist.ties[id]<=dist.total);
    const h={player:[p,1],banker:[b,2]}, altered={player:[p,8],banker:[b,29]}, table={rules:{}};
    cards.prepareRound(table,h); cards.prepareRound(table,altered);assert.deepEqual(h.areaOdds,altered.areaOdds);
    for(const id of cards.areaIds){
      assert.ok(Number.isFinite(h.areaOdds[id]));
      if(dist.wins[id])assert.ok(dist.wins[id]*h.areaOdds[id]<=dist.total-dist.wins[id]-dist.ties[id]+1e-8);
      else assert.equal(h.areaOdds[id],-1);
    }
  }
  const f=fixture();f.start(); const snapshot=engine.roomSnapshot(f.table,f.session);
  assert.deepEqual(snapshot.showdownPokers,{banker:[f.table.hand.banker[0],-1],player:[f.table.hand.player[0],-1]});
  assert.equal(snapshot.showdownTypes,undefined); assert.equal(Object.keys(snapshot.areaOdds).length,11);
  assert.throws(()=>cards.conditionalOutcomes(-1,0),/Invalid/);
});
test('impossible areas, malformed stakes, wrong rooms and expired clocks do not debit', () => {
  const f=fixture();f.start(); const bet=(params,roomId=f.table.roomId)=>engine.acceptBet(f.ctx,{roomType:62,roomId,params});
  const impossible=cards.areaIds.find(id=>f.table.hand.areaOdds[id]<=0);
  for(const total of [NaN,Infinity,-100,0,100.5,1e9+1])assert.equal(bet([{areaId:1,total}]),false);
  if(impossible)assert.equal(bet([{areaId:impossible,total:100}]),false);
  assert.equal(bet([{areaId:12,total:100}]),false); assert.equal(bet([{areaId:1,total:100}],123),false);
  f.table.phaseEndsAt=Date.now()-1; assert.equal(bet([{areaId:1,total:100}]),false);
  assert.equal(f.session.wallet,1000000); assert.equal(f.table.playerBets.size,0);
});
test('ties refund main bets, side bets settle independently and personal results populate authorized history', async () => {
  const f=fixture();f.start();
  f.table.hand={player:tiles([9,0]),banker:tiles([9,0]),...cards.outcomes(tiles([9,0]),tiles([9,0]))};
  cards.prepareRound(f.table,f.table.hand);f.table.hand.betReserveFactor=1;
  assert.equal(engine.acceptBet(f.ctx,{roomType:62,params:[{areaId:1,total:100},{areaId:3,total:100},{areaId:8,total:100}]}),true);
  const expected=1000000+cards.betNet(f.table.hand,{areaId:3,total:100},f.table.hand.areaOdds)+cards.betNet(f.table.hand,{areaId:8,total:100},f.table.hand.areaOdds);
  await engine.settleRound(f.ctx); assert.equal(f.session.wallet,expected);
  const result=f.messages.find(m=>m.id===6208).data;assert.equal(result.areaWinningScores[1],0);
  assert.equal(result.points,expected);assert.ok(f.messages.findIndex(m=>m.id===6208)<f.messages.findIndex(m=>m.id===6204&&m.data.state===5));
  assert.deepEqual(f.table.ways[1].ways[0].winArea,[3,8]);
  const detail=engine.historyDetail(f.table,11,1);assert.deepEqual(detail.showdownPokers,result.showdownPokers);
  assert.equal(detail.betDetailTableMap[1].realScore,0); assert.equal(engine.historyDetail(f.table,99,1),null);
  const count=f.table.ways[1].ways.length;await engine.settleRound(f.ctx);assert.equal(f.session.wallet,expected);assert.equal(f.table.ways[1].ways.length,count);
});
test('an unpaid settlement retries after hot reload without paying the first player twice',async()=>{
  const f=fixture();f.start();const other={userId:12,wallet:1000000};f.table.playerSessions.set(12,other);f.table.visitors.add(12);
  const id=f.table.hand.winningAreas.find(id=>f.table.hand.areaOdds[id]>0);assert.ok(id);
  for(const session of [f.session,other])assert.equal(engine.acceptBet({...f.ctx,session},{roomType:62,params:[{areaId:id,total:100}]}),true);
  let failing=true;const paid=[];f.ctx.runtime.wallet.credit=(s,n)=>{if(s.userId===12&&failing)return{ok:false};paid.push(s.userId);s.wallet+=n;return{ok:true};};
  await assert.rejects(engine.settleRound(f.ctx));failing=false;
  const hot=await import('../../../../game-server/src/games/hundred-mahjong/engine.js?v=mj-retry');await hot.settleRound(f.ctx);
  assert.deepEqual(paid,[11,12]);assert.equal(f.table.ways[1].ways.length,1);assert.equal(f.session.wallet,other.wallet);
});
test('native 26 spectator host and independent 62 connection retain isolated identities, review and exit',async()=>{
  const configs=seedRooms(),registry=createRegistry(),runtime={env:'dev',hotVersion:'hundred-mahjong-test',configs,registry,findConfig,
    gateway:{validateToken:async()=>true,getLoginData:async()=>({agentId:77,userName:'player'})},
    wallet:{load:async s=>{s.wallet=1000000;},persist:async()=>{},debit(s,n){s.wallet-=n;return{ok:true};},credit(s,n){s.wallet+=n;return{ok:true};}},log:{info(){},error(){}}};
  const handler=await createHandler(runtime);
  const socket=()=>{const frames=[],ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};return{ws,frames,send:(id,p)=>handler.onMessage(ws,encodeFrame(id,p))};};
  const main=socket(),hundred=socket(),hostRow=configs.find(r=>r.room_type===26&&r.play_mode===0&&JSON.parse(r.payload).maxPeople===4);
  const login={userId:12,userToken:'dev',roomId:hostRow.game_room_config_id*10000,openHundredGame:true};
  await main.send(SEND.ROOM_LOGIN,login);await main.send(SEND.SEND_JOIN_ROOM,{roomId:login.roomId,roomType:26,isOb:true,openHundredGame:true});
  assert.equal(main.frames.find(f=>f.msgid===2201).payload.conf.hundredSwitch,true);
  await hundred.send(SEND.ROOM_LOGIN,login);await hundred.send(SEND.ENTER,{roomType:62,playMode:0});
  assert.equal(hundred.frames.find(f=>f.msgid===6205).payload.playMode,1);
  await hundred.send(SEND.MB_REG_ROOMS_REQ,{mulRoomTypeList:[{roomType:62}],customData:2});
  assert.equal(hundred.frames.find(f=>f.msgid===6227).payload.roomInfos[0].roomType,62);
  await hundred.send(SEND.GR_GET_ALL_ROOMS_REQ,{roomType:62});assert.equal(hundred.frames.find(f=>f.msgid===6230).payload[0].roomIndex,0);
  const session=registry.session(hundred.ws),table=registry.getTable(session.hundredRoomId,77,'hundred-mahjong');
  await hundred.send(SEND.MB_UNREG_ROOMS_REQ,null);
  assert.deepEqual([...session.hundredRoomIds],[table.roomId]);assert.equal(table.visitors.has(12),true);
  await handler.tick();table.phaseEndsAt=Date.now()-1;await handler.tick();
  const areaId=cards.areaIds.find(id=>table.hand.areaOdds[id]>0);
  await hundred.send(SEND.BET,{roomType:62,roomId:table.roomId,params:[{areaId,total:100}]});
  assert.equal(hundred.frames.find(f=>f.msgid===6201).payload.code,0);assert.equal(main.frames.some(f=>f.msgid===6228),false);
  await engine.settleRound({table,runtime,io:{sendUser:(uid,id,p)=>hundred.ws.send(encodeFrame(id,p)),broadcast(){},forEachPlayer:fn=>fn(session)}});
  await hundred.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});
  assert.equal(hundred.frames.find(f=>f.msgid===6222).payload.showdownPokers.banker.length,2);
  const foreign=socket();await foreign.send(SEND.ROOM_LOGIN,{...login,userId:13});await foreign.send(SEND.ENTER,{roomType:51,playMode:1});
  await foreign.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});assert.equal(foreign.frames.some(f=>f.msgid===6222),false);
  await hundred.send(SEND.EXIT,{roomType:62});assert.equal(registry.session(main.ws).inRoom,true);assert.equal(table.visitors.has(12),false);assert.equal(session.hundredRoomIds.size,0);
});
