import test from 'node:test';
import assert from 'node:assert/strict';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { decodeFrame, encodeFrame } from '../../../../game-server/src/codec.js';
import { SEND, PUSH } from '../../../../game-server/src/messages.js';
import { HundredZjhGame } from '../../../../game-server/src/games/hundred-zjh/HundredZjhGame.js';
import * as engine from '../../../../game-server/src/games/hundred-zjh/engine.js';
import * as cards from '../../../../game-server/src/games/hundred-zjh/hand.js';
import { evaluate3 } from '../../../../game-server/src/games/zjh/hand.js';

const card = (rank, suit = 0) => suit * 13 + (rank === 14 ? 0 : rank - 1);
const rank = hand => evaluate3(hand);
function fixture(mode = 1, userId = 11) {
  const game = new HundredZjhGame();
  const row = seedRooms().find(row => row.room_type === 51 && row.play_mode === mode);
  const table = game.createTable(row.game_room_config_id * 10000 + row.room_index, 51, row);
  const session = {userId, wallet: 1000000}, messages = [];
  table.visitors.add(userId); table.playerSessions.set(userId, session);
  const io = { broadcast: (id, data) => messages.push({id, data: structuredClone(data)}),
    sendUser: (uid, id, data) => messages.push({uid, id, data: structuredClone(data)}),
    forEachPlayer: fn => fn(session) };
  const runtime = { wallet: {debit(s, n) { s.wallet -= n; return {ok: true}; },
    credit(s, n) { s.wallet += n; return {ok: true}; }} };
  const ctx = {table, session, io, runtime, send: (id, data) => io.sendUser(userId,id,data)};
  return {game, row, table, session, messages, io, ctx};
}

test('original Jinhua help: mixed-suit 235 beats trips but flush 235 does not', () => {
  const special = rank([card(2),card(3,1),card(5,2)]), trips = rank([card(7),card(7,1),card(7,2)]);
  const flush = rank([card(2),card(3),card(5)]), high = rank([card(14,3),card(11,2),card(9)]);
  assert.ok(cards.compareHands(special,trips)>0);
  assert.ok(cards.compareHands(trips,special)<0);
  assert.ok(cards.compareHands(trips,flush)>0);
  assert.ok(cards.compareHands(high,special)>0);
  assert.ok(cards.compareHands(rank([card(12),card(13),card(14)]),rank([card(14,1),card(2,1),card(3,1)]))>0);
  assert.ok(cards.compareHands(rank([card(14,3),card(10,1),card(5)]),rank([card(14,2),card(10),card(5,1)]))>0);
});

test('exact all-dark probabilities cover every disjoint deal and symmetric sides', () => {
  const {total,counts} = cards.conditionalOutcomes();
  assert.equal(total,22100*18424);
  assert.equal(counts[1],counts[2]);
  assert.equal(counts[1]+counts[2],total);
  assert.equal([3,4,5,6,7,8].reduce((n,id)=>n+counts[id],0),total);
});

test('conditional pricing matches independent brute force and never uses the actual hidden hand', () => {
  const red = [card(2),card(3,1),card(5,2)], blackKnown = [card(7,3)];
  const exact = cards.conditionalOutcomes(red,blackKnown);
  const counts = Object.fromEntries(cards.areaIds.map(id=>[id,0]));
  const deck = Array.from({length:52},(_,i)=>i).filter(c=>![...red,...blackKnown].includes(c));
  let total=0;
  for(let i=0;i<deck.length;i++)for(let j=i+1;j<deck.length;j++){
    const rr=rank(red),br=rank([...blackKnown,deck[i],deck[j]]);
    const won=cards.compareHands(rr,br)>0; counts[won?1:2]++; counts[(won?rr:br).cardTypeId+2]++; total++;
  }
  assert.deepEqual(exact,{total,counts});
  const known=cards.conditionalOutcomes(red,[card(7),card(7,1),card(7,2)]);
  assert.equal(known.total,1); assert.equal(known.counts[1],1); assert.equal(known.counts[3],1);
  assert.throws(()=>cards.conditionalOutcomes([1],[1]));
  const f=fixture(); const a=cards.createHand(f.table,()=>0.5), b=structuredClone(a);
  const unknown=Array.from({length:52},(_,i)=>i).filter(c=>![a.red[0],a.black[0]].includes(c));
  b.red=[a.red[0],unknown[0],unknown[1]];b.black=[a.black[0],unknown[2],unknown[3]];
  cards.prepareRound(f.table,a); cards.prepareRound(f.table,b);
  assert.deepEqual(a.areaOdds,b.areaOdds);
});

for(const [mode,redCount,blackCount] of [[1,1,1],[2,2,1],[3,2,2],[4,3,1],[5,0,0]]) {
  test('mode '+mode+' supports masked cards, eight odds, wallet settlement, roads and private history', async () => {
    const f=fixture(mode); engine.beginRound(f.io,f.table,1000,()=>0.5);
    assert.equal(new Set(f.table.hand.dealt).size,6);
    const snapshot=engine.roomSnapshot(f.table,f.session);
    assert.equal(snapshot.dealPokers.bankerCards.filter(c=>c>=0).length,redCount);
    assert.equal(snapshot.dealPokers.playerCards.filter(c=>c>=0).length,blackCount);
    assert.deepEqual(snapshot.bankerCards, snapshot.dealPokers.bankerCards);
    assert.deepEqual(snapshot.playerCards, snapshot.dealPokers.playerCards);
    assert.deepEqual(snapshot.showdownPokers,{hong:snapshot.dealPokers.bankerCards,hei:snapshot.dealPokers.playerCards});
    assert.equal('board' in snapshot.showdownPokers,false);
    assert.deepEqual(engine.historyList(f.table,11).list,[]);
    const deal=f.messages.find(m=>m.id===6212).data;
    for(const id of cards.areaIds){assert.ok(Number.isFinite(deal.areaOdds[id]));assert.deepEqual(snapshot.hundredParams.betAreaOdds[id],{id,odds:deal.areaOdds[id]});}
    engine.tick(f.io,f.table,2000,f.ctx);
    const live=f.messages.filter(m=>m.id===6228).at(-1).data;
    assert.equal(live.customData,2);assert.equal(live.state,2);assert.equal(live.countDown>=0,true);
    const areaId=cards.areaIds.find(id=>deal.areaOdds[id]>0);
    assert.equal(engine.acceptBet(f.ctx,{roomType:51,params:[{areaId,total:10000}]}),true);
    const expected=f.table.hand.winningAreas.includes(areaId)?Math.floor(10000*deal.areaOdds[areaId]):-10000;
    f.table.rules.betAreaOdds={}; // Current-hand pricing remains frozen.
    assert.equal(await engine.settleRound(f.ctx),true);
    assert.equal(f.session.wallet,1000000+expected);
    const result=f.messages.find(m=>m.id===6229&&m.uid===11).data;
    assert.equal(result.realScore,expected);
    assert.deepEqual(Object.keys(result.showdownPokers).sort(),['hei','hong']);
    assert.equal(result.showdownPokers.hong.length,3);assert.equal(result.showdownPokers.hei.length,3);
    assert.deepEqual(result.winningAreas,f.table.hand.winningAreas);
    assert.equal(typeof result.ways[1].ways[0].heiHong,'boolean');
    assert.equal(result.ways[1].ways[0].paiXing,f.table.hand.winningType);
    const detail=engine.historyDetail(f.table,11,1);
    assert.equal(detail.betDetailTableMap[areaId].realScore,expected);
    assert.equal(detail.betDetailTableMap[areaId].odds,deal.areaOdds[areaId]);
    assert.equal(engine.historyDetail(f.table,12,1),null);
    assert.equal(await engine.settleRound(f.ctx),false);
    assert.equal(f.messages.filter(m=>m.id===6229&&m.uid===11).length,1);
  });
}

test('failed settlement resumes after hot reload without paying earlier winners twice', async () => {
  const f = fixture(5); engine.beginRound(f.io, f.table); f.table.state = 2;
  const other = { userId: 12, wallet: 1000000 };
  f.table.playerSessions.set(12, other); f.table.visitors.add(12);
  engine.acceptBet(f.ctx, { roomType: 51, params: [{ areaId: 1, total: 100 }] });
  engine.acceptBet({ ...f.ctx, session: other }, { roomType: 51, params: [{ areaId: 1, total: 100 }] });
  f.table.hand.winningAreas = [1, 3];
  f.table.state = 4;
  let failing = true; const credits = [];
  f.ctx.runtime.wallet.credit = (s, amount) => {
    if (s.userId === 12 && failing) return { ok: false };
    credits.push(s.userId); s.wallet += amount; return { ok: true };
  };
  await assert.rejects(engine.settleRound(f.ctx), /credit rejected/);
  assert.equal(f.table.state, 4); assert.equal(f.table.hand.settled, undefined);
  assert.equal(f.table.hundredSettledInning, undefined);
  assert.equal(f.table.ways[1].ways.length, 1);
  assert.equal(f.messages.some(m => m.id === 6229), false);
  failing = false;
  const hot = await import('../../../../game-server/src/games/hundred-zjh/engine.js?v=retry-settlement');
  assert.equal(await hot.settleRound(f.ctx), true);
  assert.deepEqual(credits, [11, 12]);
  assert.equal(f.session.wallet, other.wallet);
  assert.equal(f.table.ways[1].ways.length, 1);
  assert.equal(await engine.settleRound(f.ctx), false);
});

test('invalid, disabled, duplicate-over-limit and late bets cannot mutate wallet or accepted bets', () => {
  const f=fixture(4);engine.beginRound(f.io,f.table);f.table.state=2;
  f.table.rules.maxBet=1000;
  const valid=cards.areaIds.find(id=>f.table.hand.areaOdds[id]>0);
  const disabled=cards.areaIds.find(id=>f.table.hand.areaOdds[id]===0);
  const cases=[[{areaId:9,total:100}], [{areaId:valid,total:NaN}], [{areaId:valid,total:-100}],
    [{areaId:valid,total:1.5}], [{areaId:valid,total:600},{areaId:valid,total:600}],
    [{areaId:valid,total:100},{areaId:9,total:100}]];
  if(disabled)cases.push([{areaId:disabled,total:100}]);
  for(const params of cases){assert.equal(engine.acceptBet(f.ctx,{roomType:51,params}),false);assert.equal(f.session.wallet,1000000);assert.equal(f.table.playerBets.size,0);}
  assert.equal(engine.acceptBet(f.ctx,{roomType:51,params:[{areaId:valid,total:600}]}),true);
  assert.equal(engine.acceptBet(f.ctx,{roomType:51,params:[{areaId:valid,total:600}]}),false);
  f.table.state=4;assert.equal(engine.acceptBet(f.ctx,{roomType:51,params:[{areaId:valid,total:100}]}),false);
  assert.equal(f.session.wallet,999400);
});

test('native dual connection enters Jinhua host, registers five rooms, bets, reviews and exits independently', async () => {
  const registry=createRegistry();
  const runtime={hotVersion:'hundred-zjh-wire',configs:seedRooms(),registry,findConfig,
    gateway:{validateToken:async()=>true,getLoginData:async()=>({agentId:77,userName:'player'})},
    wallet:{load:async s=>{s.wallet=1000000;},persist:async()=>{},
      debit(s,n){s.wallet-=n;return {ok:true};},credit(s,n){s.wallet+=n;return {ok:true};}},log:{info(){},error(){}}};
  const handler=await createHandler(runtime);
  const socket=()=>{const frames=[];const ws={readyState:1,send:raw=>frames.push(decodeFrame(raw))};return{ws,frames,send:(id,data)=>handler.onMessage(ws,encodeFrame(id,data))};};
  const main=socket(),hundred=socket();
  const login={userId:12,userToken:'dev',roomId:25010000,openHundredGame:true};
  await main.send(SEND.ROOM_LOGIN,login);
  await main.send(SEND.SEND_JOIN_ROOM,{roomId:login.roomId,roomType:25,isOb:true,openHundredGame:true});
  const host=main.frames.find(f=>f.msgid===2201).payload;assert.equal(host.conf.hundredSwitch,true);assert.equal(host.roomType,25);
  await hundred.send(SEND.ROOM_LOGIN,login);await hundred.send(SEND.ENTER,{roomType:51,playMode:1});
  await hundred.send(SEND.MB_REG_ROOMS_REQ,{mulRoomTypeList:[{roomType:51}],customData:2});
  const rooms=hundred.frames.find(f=>f.msgid===6227).payload.roomInfos;
  assert.equal(rooms.length,5);assert.deepEqual(rooms.map(r=>r.playMode).sort(),[1,2,3,4,5]);
  assert.ok(rooms.every(r=>r.roomType===51));
  const state=registry.session(hundred.ws),table=registry.getTable(state.hundredRoomId,77,'hundred-zjh');
  const game=new HundredZjhGame();
  await handler.tick();table.phaseEndsAt=0;await handler.tick();
  const areaId=cards.areaIds.find(id=>table.hand.areaOdds[id]>0);
  await hundred.send(SEND.MB_ROOM_BET_REQ,{roomId:table.roomId,roomType:51,params:[{areaId,total:100}]});
  assert.equal(hundred.frames.find(f=>f.msgid===6226).payload.code,0);
  assert.equal(main.frames.some(f=>f.msgid===6228),false);
  await game.engine.settleRound({table,session:state,runtime,io:{sendUser:(uid,id,p)=>hundred.ws.send(encodeFrame(id,p)),broadcast(){},forEachPlayer:fn=>fn(state)}});
  await hundred.send(SEND.REQUEST_100_RECORD,{roomId:table.roomId,roomType:51});
  assert.deepEqual(hundred.frames.find(f=>f.msgid===6221).payload.list,[1]);
  await hundred.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});
  assert.equal(hundred.frames.find(f=>f.msgid===6222).payload.showdownPokers.hong.length,3);
  const foreign=socket();await foreign.send(SEND.ROOM_LOGIN,{...login,userId:13});
  await foreign.send(SEND.ENTER,{roomType:50,playMode:1});
  await foreign.send(SEND.REQUEST_ONE_RECORD,{gameRoomId:table.roomId,currInning:1});
  assert.equal(foreign.frames.some(f=>f.msgid===6222),false);
  await hundred.send(SEND.EXIT,{roomType:51});
  assert.equal(registry.session(main.ws).inRoom,true);
  assert.ok(registry.getTable(login.roomId,77,'zjh').observers.some(p=>p.uid===12));
  for(const room of registry.listAgentGameRooms(77,'hundred-zjh'))assert.equal(room.visitors.has(12),false);
});
