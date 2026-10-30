import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { HundredNiuniuGame } from '../../../../game-server/src/games/hundred-niuniu/HundredNiuniuGame.js';
import * as cards from '../../../../game-server/src/games/hundred-niuniu/hand.js';
import * as engine from '../../../../game-server/src/games/hundred-niuniu/engine.js';
import { roomRules } from '../../../../game-server/src/games/hundred-niuniu/config.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { decodeFrame, encodeFrame } from '../../../../game-server/src/codec.js';
import { SEND } from '../../../../game-server/src/messages.js';
const card = (rank, suit = 0) => suit * 13 + rank - 1;
test('room configuration bounds modes and editable special multipliers', () => {
  assert.equal(roomRules({play_mode:1}).minBet,100);
  assert.throws(()=>roomRules({play_mode:6}),/Unsupported/);
  for(const multiplier of [0,11,NaN,1.5])assert.throws(()=>roomRules({play_mode:1,
    payload:{hundredParams:{specialPayoutMultiple:multiplier}}}),/multiplier/);
  assert.equal(roomRules({play_mode:1,payload:{hundredParams:{specialPayoutMultiple:8}}}).specialPayoutMultiple,8);
});
function fixture(mode = 1) {
  const game = new HundredNiuniuGame();
  const row = seedRooms().find(row => row.room_type === 52 && row.play_mode === mode);
  const table = game.createTable(row.game_room_config_id * 10000 + row.room_index, 52, row);
  const session = { userId: 11, wallet: 1000000 }, messages = [];
  table.visitors.add(11); table.playerSessions.set(11, session);
  const io = { broadcast: (id, data) => messages.push({ id, data: structuredClone(data) }),
    sendUser: (uid, id, data) => messages.push({ uid, id, data: structuredClone(data) }),
    forEachPlayer: fn => fn(session) };
  const runtime = { wallet: { debit(s, n) { s.wallet -= n; return { ok: true }; },
    credit(s, n) { s.wallet += n; return { ok: true }; } } };
  const ctx = { game, table, session, io, runtime, send: (id, data) => io.sendUser(11, id, data) };
  return { game, row, table, session, messages, io, ctx };
}
test('captured four-card result reproduces types, winners and the four-times loss', () => {
  const cs = { a: [3,20,27,25,34], b: [19,39,32,1,21], c: [0,4,37,18,48], banker: [29,36,49,24,38] };
  const ranks = Object.fromEntries(cards.positions.map(key => [key, cards.rankHand(cs[key])]));
  assert.deepEqual(Object.fromEntries(cards.positions.map(key => [key,ranks[key].niuType])), {a:3,b:6,c:0,banker:4});
  const winningAreas = ['a','b','c'].map((key,i) => cards.compareHands(ranks[key], ranks.banker) > 0 ? i+1 : i+4);
  assert.deepEqual(winningAreas, [4,2,6]);
  const hand = { cards: cs, ranks, winningAreas, betReserveFactor: 10 };
  assert.equal(cards.betNet(hand,{areaId:1,total:100},{1:0.87}),-400);
  assert.equal(cards.betNet(hand,{areaId:4,total:100},{4:1.14}),456);
});
test('ordinary same-type hands compare highest rank then diamond-club-heart-spade suit', () => {
  const low = cards.rankHand([card(1),card(2),card(7),card(10,1),card(10,2)]);
  const high = cards.rankHand([card(1,1),card(2,1),card(7,1),card(10),card(10,3)]);
  assert.equal(low.niuType,10); assert.equal(high.niuType,10);
  assert.ok(cards.compareHands(high,low)>0);
  const straightFlush = cards.rankHand([6,7,8,9,10].map(n=>card(n,2)));
  assert.equal(straightFlush.niuType,18);
  assert.ok(cards.compareHands(straightFlush,high)>0);
  assert.equal(cards.payoutMultiple(straightFlush),10);
  assert.equal(cards.payoutMultiple({niuType:0}),1);
});
for (const [mode, count] of [[1,3],[2,4],[3,2],[4,1],[5,0]]) {
  test('Niuniu mode '+mode+' masks cards, reserves risk, settles once and renders authorized history', async () => {
    const f=fixture(mode); engine.beginRound(f.io,f.table,1000,()=>0.43);
    assert.equal(new Set(f.table.hand.dealt).size,20);
    const snapshot=engine.roomSnapshot(f.table,f.session);
    for(const key of cards.positions) {
      assert.equal(snapshot.dealPokers[key].length,5);
      assert.equal(snapshot.dealPokers[key].filter(c=>c>=0).length,count);
      assert.deepEqual(snapshot[key],snapshot.dealPokers[key]);
      assert.deepEqual(snapshot.showdownPokers[key],snapshot.dealPokers[key]);
    }
    assert.deepEqual(snapshot.ways[1].ways,{1:[],2:[],3:[]});
    assert.equal(snapshot.ways[2].aWinCount,0);
    const deal=f.messages.find(m=>m.id===6212).data;
    for(const id of cards.areaIds) {
      assert.ok(Number.isFinite(deal.areaOdds[id])&&deal.areaOdds[id]>=0);
      assert.deepEqual(snapshot.hundredParams.betAreaOdds[id],{id,odds:deal.areaOdds[id]});
    }
    engine.tick(f.io,f.table,2000,f.ctx);
    const areaId=cards.areaIds.find(id=>deal.areaOdds[id]>0);
    assert.equal(engine.acceptBet(f.ctx,{roomType:52,roomId:f.table.roomId,params:[{areaId,total:10000}]}),true);
    assert.equal(f.session.wallet,900000,'maximum ten-times exposure is held before settlement');
    const expected=cards.betNet(f.table.hand,{areaId,total:10000},deal.areaOdds);
    f.table.rules.betAreaOdds={};
    f.table.rules.specialPayoutMultiple=1; // Accepted round keeps its original multiplier.
    assert.equal(await engine.settleRound(f.ctx),true);
    assert.equal(f.session.wallet,1000000+expected);
    const result=f.messages.find(m=>m.id===6229&&m.uid===11).data;
    assert.equal(result.realScore,expected);
    assert.deepEqual(Object.keys(result.showdownPokers).sort(),['a','b','banker','c']);
    assert.equal(result.winningAreas.length,3);
    for(let i=1;i<=3;i++) {
      assert.notEqual(result.winningAreas.includes(i),result.winningAreas.includes(i+3));
      assert.equal(result.ways[1].ways[i].length,1);
    }
    assert.equal(result.aWinCount,Number(result.winningAreas.includes(1)));
    const detail=engine.historyDetail(f.table,11,1);
    assert.deepEqual(detail.showdownPokers,result.showdownPokers);
    assert.equal(detail.betDetailTableMap[areaId].betScore,10000);
    assert.equal(detail.betDetailTableMap[areaId].realScore,expected);
    assert.ok(detail.betDetailTableMap[areaId].score>=0);
    assert.equal(engine.historyDetail(f.table,12,1),null);
    assert.equal(await engine.settleRound(f.ctx),false);
    assert.equal(f.messages.filter(m=>m.id===6229&&m.uid===11).length,1);
    const reconnect=engine.roomSnapshot(f.table,f.session);
    assert.deepEqual(reconnect.showdownPokers,result.showdownPokers);
    const hot=await import('../../../../game-server/src/games/hundred-niuniu/engine.js?v=settled');
    assert.equal(await hot.settleRound(f.ctx),false);
  });
}
test('conditional prices depend only on all four public hands and are reproducible', () => {
  const f=fixture(); const a=cards.createHand(f.table,()=>0.42), b=structuredClone(a);
  const publicCards=cards.positions.flatMap(key=>a.cards[key].slice(0,3));
  const deck=Array.from({length:52},(_,i)=>i).filter(c=>!publicCards.includes(c));
  cards.positions.forEach((key,i)=>{b.cards[key]=[...a.cards[key].slice(0,3),...deck.slice(i*2,i*2+2)];});
  cards.prepareRound(f.table,a);cards.prepareRound(f.table,b);
  assert.deepEqual(a.areaOdds,b.areaOdds);
  assert.deepEqual(cards.conditionalOdds(Object.fromEntries(cards.positions.map(key=>[key,[-1,-1,-1,-1,-1]]))),
    {1:1,2:1,3:1,4:1,5:1,6:1});
  const invalid=cards.visibleCards(a,f.table.rules); invalid.b[0]=invalid.a[0];
  assert.throws(()=>cards.conditionalOdds(invalid),/Invalid public/);
  assert.throws(()=>cards.conditionalOdds(cards.visibleCards(a,f.table.rules),1e9),/sample/);
});
test('underfunded, malformed and over-limit requests do not partially debit or accept bets', () => {
  const f=fixture(5);engine.beginRound(f.io,f.table);f.table.state=2;f.table.rules.maxBet=1000;
  f.session.wallet=999;
  assert.equal(engine.acceptBet(f.ctx,{roomType:52,params:[{areaId:1,total:100}]}),false);
  f.session.wallet=10000;
  for(const params of [[{areaId:1,total:NaN}],[{areaId:7,total:100}],
    [{areaId:1,total:600},{areaId:1,total:500}],[{areaId:1,total:100},{areaId:2,total:-1}]])
    assert.equal(engine.acceptBet(f.ctx,{roomType:52,params}),false);
  assert.equal(f.session.wallet,10000);assert.equal(f.table.playerBets.size,0);
  assert.equal(engine.acceptBet(f.ctx,{roomType:52,params:[{areaId:1,total:1000}]}),true);
  assert.equal(f.session.wallet,0);
});
test('roads retain the most recent hundred hands and recalculate matching win statistics', () => {
  const f=fixture(5);
  for(let i=0;i<125;i++)cards.updateRoads(f.table,{winningAreas:i%2?[1,2,3]:[4,5,6]});
  assert.equal(f.table.ways[2].ways.length,100);
  for(const row of Object.values(f.table.ways[1].ways))assert.equal(row.length,100);
  assert.deepEqual(cards.statistics(f.table),{aWinCount:50,bWinCount:50,cWinCount:50});
});
test('hot reload converts early public roads without resetting the resident hand or funds', () => {
  const f=fixture(5);engine.beginRound(f.io,f.table);const hand=f.table.hand;
  f.table.ways=[[1,-1,1],[-1,1,-1]];
  const snapshot=engine.roomSnapshot(f.table,f.session);
  assert.deepEqual(snapshot.ways[1].ways,{1:[1,-1],2:[-1,1],3:[1,-1]});
  assert.deepEqual(cards.statistics(f.table),{aWinCount:1,bWinCount:1,cWinCount:1});
  assert.equal(f.table.hand,hand);assert.equal(f.session.wallet,1000000);
});
test('failed Niuniu payout retains the ten-times reserve and retries only unpaid players', async () => {
  const f=fixture(5);engine.beginRound(f.io,f.table);f.table.state=2;
  const other={userId:12,wallet:1000000};f.table.playerSessions.set(12,other);f.table.visitors.add(12);
  const areaId=f.table.hand.winningAreas[0]; // Always exercise a real credit, including a ten-times winning hand.
  engine.acceptBet(f.ctx,{roomType:52,params:[{areaId,total:100}]});
  engine.acceptBet({...f.ctx,session:other},{roomType:52,params:[{areaId,total:100}]});
  let failing=true; const paid=[]; f.ctx.runtime.wallet.credit=(s,n)=>{
    if(s.userId===12&&failing)return {ok:false};paid.push(s.userId);s.wallet+=n;return {ok:true};
  };
  await assert.rejects(engine.settleRound(f.ctx));
  assert.equal(f.table.hand.settled,undefined);assert.equal(f.table.ways[2].ways.length,1);
  failing=false;const hot=await import('../../../../game-server/src/games/hundred-niuniu/engine.js?v=retry');
  await hot.settleRound(f.ctx);assert.deepEqual(paid,[11,12]);
  assert.equal(f.session.wallet,other.wallet);assert.equal(f.table.ways[2].ways.length,1);
});
test('an earlier one-reserve hand finishes with its accepted liability before the policy changes', async () => {
  const f=fixture(5);engine.beginRound(f.io,f.table);f.table.hand.betReserveFactor=1;f.table.state=2;
  const areaId=cards.areaIds.find(id=>!f.table.hand.winningAreas.includes(id));
  engine.acceptBet(f.ctx,{roomType:52,params:[{areaId,total:100}]});
  assert.equal(f.session.wallet,999900);
  assert.equal(await engine.settleRound(f.ctx),true);
  assert.equal(f.session.wallet,999900);
  engine.beginRound(f.io,f.table);assert.equal(f.table.hand.betReserveFactor,10);
});
test('native dual connection keeps Niuniu host and five hundred rooms independently authorized', async () => {
  const registry=createRegistry(),configs=seedRooms();
  const runtime={hotVersion:'hundred-niuniu-wire',configs,registry,findConfig,
    gateway:{validateToken:async()=>true,getLoginData:async()=>({agentId:77,userName:'player'})},
    wallet:{load:async s=>{s.wallet=1000000;},persist:async()=>{},
      debit(s,n){s.wallet-=n;return {ok:true};},credit(s,n){s.wallet+=n;return {ok:true};}},log:{info(){},error(){}}};
  const handler=await createHandler(runtime);
  const socket=()=>{const frames=[];const ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};
    return{ws,frames,send:(id,p)=>handler.onMessage(ws,encodeFrame(id,p))};};
  const main=socket(),hundred=socket();
  const hostRow=configs.find(r=>r.room_type===24&&r.play_mode===3&&r.see_card_no===4);
  const login={userId:12,userToken:'dev',roomId:hostRow.game_room_config_id*10000,openHundredGame:true};
  await main.send(SEND.ROOM_LOGIN,login);
  await main.send(SEND.SEND_JOIN_ROOM,{roomId:login.roomId,roomType:24,isOb:true,openHundredGame:true});
  const host=main.frames.find(f=>f.msgid===2201).payload;
  assert.equal(host.conf.hundredSwitch,true);assert.equal(host.roomType,24);
  await hundred.send(SEND.ROOM_LOGIN,login);await hundred.send(SEND.ENTER,{roomType:52,playMode:2});
  await hundred.send(SEND.MB_REG_ROOMS_REQ,{mulRoomTypeList:[{roomType:52}],customData:2});
  const rooms=hundred.frames.find(f=>f.msgid===6227).payload.roomInfos;
  assert.equal(rooms.length,5);assert.ok(rooms.every(r=>r.roomType===52));
  const state=registry.session(hundred.ws),table=registry.getTable(state.hundredRoomId,77,'hundred-niuniu');
  await handler.tick();table.phaseEndsAt=0;await handler.tick();
  await hundred.send(SEND.MB_ROOM_BET_REQ,{roomId:table.roomId,roomType:52,params:[{areaId:1,total:100}]});
  assert.equal(hundred.frames.find(f=>f.msgid===6226).payload.code,0);
  assert.equal(main.frames.some(f=>f.msgid===6228),false);
  await engine.settleRound({table,session:state,runtime,io:{sendUser:(uid,id,p)=>hundred.ws.send(encodeFrame(id,p)),broadcast(){},forEachPlayer:fn=>fn(state)}});
  await hundred.send(SEND.REQUEST_100_RECORD,{roomId:table.roomId,roomType:52});
  assert.deepEqual(hundred.frames.find(f=>f.msgid===6221).payload.list,[1]);
  await hundred.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});
  const detail=hundred.frames.find(f=>f.msgid===6222).payload;
  assert.ok(cards.positions.every(key=>detail.showdownPokers[key].length===5));
  const foreign=socket();await foreign.send(SEND.ROOM_LOGIN,{...login,userId:13});
  await foreign.send(SEND.ENTER,{roomType:51,playMode:1});
  await foreign.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});
  assert.equal(foreign.frames.some(f=>f.msgid===6222),false);
  await hundred.send(SEND.EXIT,{roomType:52});
  assert.equal(registry.session(main.ws).inRoom,true);
  assert.ok(registry.getTable(login.roomId,77,'niuniu').observers.some(p=>p.uid===12));
  for(const room of registry.listAgentGameRooms(77,'hundred-niuniu'))assert.equal(room.visitors.has(12),false);
});
