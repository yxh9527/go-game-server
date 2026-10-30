import test from 'node:test';
import assert from 'node:assert/strict';
import { BaccaratGame } from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import config from '../../../game-server/src/games/baccarat/config.js';
import * as engine from '../../../game-server/src/games/baccarat/engine.js';
import * as rules from '../../../game-server/src/games/baccarat/rules.js';
import * as pricing from '../../../game-server/src/games/baccarat/odds.js';
import * as owner from '../../../game-server/src/games/baccarat/table-owner.js';
import * as history from '../../../game-server/src/games/baccarat/history.js';
import { seedRooms } from '../../../cache/rpc/seed.js';
import { createRoomLogic } from '../../../hall/src/rooms.js';
import * as decode from '../../../hall/src/decode.js';

function fixture(mode = 0) {
  const game = new BaccaratGame(), table = game.createTable(700001, 58,
    { play_mode: mode, room_index: 1, robot_behavior: { enabled: false } });
  table.agentId = 7;
  const messages = [], credits = [], session = { userId: 71, wallet: 1000000, name: 'tester' };
  const wallet = { debit(s, n) { if (s.wallet < n) return { ok: false }; s.wallet -= n; return { ok: true }; },
    credit(s, n) { credits.push(n); s.wallet += n; return { ok: true }; }, async persist() {} };
  const io = { wallet, broadcast(id, data) { messages.push({ id, data: structuredClone(data) }); },
    sendUser(uid, id, data) { messages.push({ uid, id, data: structuredClone(data) }); },
    forEachPlayer(fn) { fn(session); } };
  const ctx = { table, session, io, runtime: { wallet, env: 'dev' }, send: (id, data) => io.sendUser(71, id, data) };
  game.enter(table, session);
  return { game, table, ctx, io, wallet, session, messages, credits };
}

test('Baccarat catalog has all fifty native rooms and exact VIP index addressing', () => {
  const rooms = createRoomLogic(decode), rows = seedRooms();
  const bjl = rooms.filterRooms(rows, { gameType: 1002 });
  assert.equal(bjl.length, 50);
  for (let mode = 0; mode <= 4; mode++) {
    const list = bjl.filter(r => r.play_mode === mode);
    assert.equal(list.length, 10);
    for (const row of list) {
      assert.equal(rooms.findRoom(rows, { roomType: 58, playMode: mode, roomIndex: row.room_index }), row);
      assert.equal(JSON.parse(row.payload).hundredGame, 1);
    }
  }
  assert.equal(new Set(bjl.map(r => rooms.assignRoomId(r))).size, 50);
  assert.equal(rooms.findRoom(rows, { roomType: 58, playMode: 4, roomIndex: 11 }), null);
  assert.throws(() => fixture(5), /Unsupported/);
});

test('Baccarat published prices cover all nine areas and every bonus tier', () => {
  const prices = pricing.configuredOdds(config);
  assert.deepEqual(Object.values(prices).map(p => p.oddsList),
    [[100], [95], [800], [1100], [1100], [1200, 2000], [600, 1500], [3000, 4000, 10000], [9]]);
});

const outcomes = [
  { p: [0, 1], b: [2, 2], win: 6, odds: 12 },
  { p: [0, 1], b: [0, 1, 2], win: 6, odds: 20 },
  { p: [2, 3], b: [0, 1], win: 7, odds: 6 },
  { p: [0, 1, 3], b: [0, 1], win: 7, odds: 15 },
  { p: [2, 3], b: [1, 3], win: 8, odds: 30 },
  { p: [0, 1, 3], b: [1, 3], win: 8, odds: 40 },
  { p: [0, 1, 3], b: [0, 1, 2], win: 8, odds: 100 },
];
for (const row of outcomes) test('Baccarat bonus ' + row.win + ' pays ' + row.odds + ':1 once', async () => {
  const f = fixture(), before = f.session.wallet;
  assert.equal(f.game.placeBet(f.ctx, { params: [{ areaId: row.win, total: 100 }] }), true);
  const result = rules.winningAreas(row.p, row.b);
  assert.ok(result.areas.includes(row.win));
  f.table.lastResult = { ...result, player: row.p, banker: row.b };
  await engine.applyCycle(f.io, f.table, 6); await engine.applyCycle(f.io, f.table, 6);
  assert.equal(f.session.wallet, before + row.odds * 100);
  assert.equal(f.credits.length, 1);
  const detail = await history.detail(f.ctx, f.table.inning);
  assert.equal(detail.betDetailTableMap[row.win].odds, row.odds);
});

test('Baccarat not-tie is independent of banker six; pairs only use first two ranks', () => {
  assert.deepEqual(rules.winningAreas([3, 4], [0, 1]).areas, [1, 9]);
  assert.deepEqual(rules.winningAreas([0, 13, 4], [1, 14, 2]).areas, [3, 4, 5]);
  assert.ok(!rules.winningAreas([0, 1, 13], [2, 3]).areas.includes(4));
});

test('Baccarat third-card matrix and naturals agree for all first totals and third values', () => {
  const two = total => [9, total === 0 ? 9 : total - 1];
  const allowed = [null, null, null, [0,1,2,3,4,5,6,7,9], [2,3,4,5,6,7], [4,5,6,7], [6,7], []];
  for (let p = 0; p <= 9; p++) for (let b = 0; b <= 9; b++) for (let v = 0; v <= 9; v++) {
    const third = v === 0 ? 9 : v - 1;
    const actual = rules.drawBaccarat([...two(p), ...two(b), third, 6], 0);
    const natural = p >= 8 || b >= 8;
    const playerDraw = !natural && p <= 5;
    const bankerDraw = !natural && (playerDraw ? b <= 2 || allowed[b]?.includes(v) : b <= 5);
    assert.equal(actual.player.length, playerDraw ? 3 : 2, 'player ' + [p,b,v]);
    assert.equal(actual.banker.length, bankerDraw ? 3 : 2, 'banker ' + [p,b,v]);
    assert.equal(actual.next, actual.player.length + actual.banker.length);
  }
});

test('Baccarat staged points and supply states match the original peek renderer', () => {
  assert.deepEqual(rules.pointStages([0,1,2]), [3,6]);
  assert.deepEqual(rules.pointStages([2,3]), [7]);
  for (const [p,b,want] of [[[2,3],[2,2],1], [[0,1,2],[9,9,2],2],
    [[0,1,2],[0,1,2],3], [[0,1,2],[2,3],4], [[2,3],[0,1,2],5]]) assert.equal(rules.supplyState(p,b),want);
});

test('Baccarat conditional probabilities equal exhaustive no-replacement dealing', () => {
  const shoe = [0,1,2,4,9,12], fixed = { other: 0, banker: 2 };
  const actual = pricing.outcomeProbabilities(shoe, fixed), expected = actual.map(a => a.map(() => 0));
  function permutations(a) { return a.length ? a.flatMap((x,i) => permutations(a.filter((_,j)=>i!==j)).map(r=>[x,...r])) : [[]]; }
  const permutationsLeft = permutations(shoe.filter(n => n !== 0 && n !== 2));
  for (const [p2,b2,c5,c6] of permutationsLeft) {
    const hand = rules.drawBaccarat([0,p2,2,b2,c5,c6], 0), result = rules.winningAreas(hand.player,hand.banker);
    for (const id of result.areas) {
      const tier = id === 6 ? hand.banker.length - 2 : id === 7 ? hand.player.length - 2 : id === 8 ? hand.player.length + hand.banker.length - 4 : 0;
      expected[id][tier] += 1 / permutationsLeft.length;
    }
  }
  for (let id=1;id<=9;id++) actual[id].forEach((p,tier)=>assert.ok(Math.abs(p-expected[id][tier])<1e-12, id+':'+tier));
});

test('Baccarat bright prices depend on public cards and composition, never hidden shoe order', () => {
  const shoe = Array.from({ length: 416 }, (_, i) => i % 52);
  const prices = pricing.brightOdds(shoe, { other: 3, banker: 5 }, config);
  assert.deepEqual(prices, pricing.brightOdds(shoe.slice().reverse(), { other: 3, banker: 5 }, config));
  for (const value of Object.values(prices)) for (const n of value.oddsList) assert.ok(Number.isSafeInteger(n) && n >= 0);
  const probability = pricing.outcomeProbabilities(shoe);
  assert.ok(Math.abs(probability[1][0]+probability[2][0]+probability[3][0]-1)<1e-10);
  assert.throws(()=>pricing.outcomeProbabilities([1,2,3,4,5,6],{other:0,banker:1}),/not in the shoe/);
});

test('Baccarat frozen prices survive hot configuration changes and snapshots hide future cards', async () => {
  const f = fixture();
  f.table.deck = [3,4,0,1,...Array(50).fill(9)];
  f.game.tick(f.ctx);
  f.game.placeBet(f.ctx, { params: [{ areaId: 1, total: 100 }] });
  f.table.config = { ...config, odds: { ...config.odds, 1: 10 } };
  engine.applyCycle(f.io,f.table,3); engine.applyCycle(f.io,f.table,4);
  const afterDeal = f.table.deckPos;
  engine.applyCycle(f.io,f.table,4);
  assert.equal(f.table.deckPos,afterDeal); assert.equal(f.table.shoeHands,1);
  await engine.applyCycle(f.io,f.table,6);
  assert.equal(f.session.wallet,1000100);
  const bright = fixture(3); bright.game.tick(bright.ctx);
  const snapshot = bright.game.enterSnapshot(bright.table,bright.session);
  assert.equal(snapshot.showdownPokers,undefined); assert.equal(snapshot.deck,undefined);
  assert.deepEqual(snapshot.otherShowPoker,[bright.table.preparedHand.player[0]]);
  assert.deepEqual(snapshot.bankerShowPoker,[bright.table.preparedHand.banker[0]]);
});

test('Baccarat five modes preserve correct phases and two-stage conditional supplements', () => {
  for (let mode=0;mode<=4;mode++) {
    const f=fixture(mode);f.table.supplyState=3;
    const phases=engine.phasesFor(f.table);
    assert.equal(phases.find(p=>p.cycle===0).seconds,[25,20,15,25,20][mode]);
    assert.equal(phases.filter(p=>p.state===9).length,[1,3,4].includes(mode)?2:0);
    if(mode===4)assert.ok(phases.filter(p=>p.state===9).every(p=>p.skip));
    assert.equal(phases[0].state,mode===3?1:2);
    if(mode===3)assert.ok(phases[0].seconds>=5,'complete native pre-deal before betting');
  }
  const f=fixture(1);f.table.supplyState=3;
  assert.ok(engine.phasesFor(f.table).filter(p=>p.state===9).every(p=>!p.skip));
  engine.applyCycle(f.io,f.table,90);assert.equal(f.table.otherSupply,false);
  engine.applyCycle(f.io,f.table,91);assert.equal(f.table.otherSupply,true);
  f.table.supplyState=2;
  assert.equal(engine.phasesFor(f.table).find(p=>p.cycle===91).skip,true);
  f.table.supplyState=1;
  assert.ok(engine.phasesFor(f.table).filter(p=>p.state===9).every(p=>p.skip));
});

test('Baccarat shuffle consumes exposed burn cards once and clears only finished shoe roads', () => {
  const f=fixture();f.table.ways[1]=[{winArea:[1]}];f.table.shoeHands=30;
  engine.applyCycle(f.io,f.table,80);
  const message=f.messages.find(m=>m.id===6223).data;
  assert.equal(f.table.deckPos,message.point+1);
  assert.equal(f.table.remainCardsNum,416-message.point-1);
  assert.equal(f.table.collectCardCount,f.table.deckPos);assert.equal(f.table.shoeHands,0);
  assert.deepEqual(f.table.ways[1],[]);
  engine.applyCycle(f.io,f.table,8);assert.equal(f.table.shoeHands,0);
  engine.prepareHand(f.io,f.table);assert.equal(f.table.preparedHand.start,message.point+1);
});

test('Baccarat hot migration aligns old phase indices without reopening or extending a live hand', () => {
  const f=fixture(3),deadline=Date.now()+5000;
  f.table.state=4;f.table.hundredPhaseIndex=2;f.table.phaseEndsAt=deadline;
  f.table.lastResult={player:[1,2],banker:[3,4],areas:[2],p:5,b:9};
  const result=f.table.lastResult;
  f.game.tick(f.ctx);
  assert.equal(f.table.state,4);assert.equal(f.table.hundredPhaseIndex,3);
  assert.equal(f.table.phaseEndsAt,deadline);assert.equal(f.table.lastResult,result);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),false);
  const classic=fixture();classic.table.state=0;classic.table.hundredPhaseIndex=5;classic.table.phaseEndsAt=deadline;
  engine.migrateTable(classic.table);assert.equal(classic.table.hundredPhaseIndex,6);
  assert.equal(classic.table.phaseEndsAt,deadline);
});

test('Baccarat VIP ordinary entry remains observer once claimed; owner settings apply next hand', () => {
  const f=fixture(4);owner.enter(f.ctx,{vipTableMode:1});assert.equal(f.table.baccaratOwner,undefined);
  const wallet=f.session.wallet;owner.enter(f.ctx,{vipTableMode:0});assert.equal(f.table.baccaratOwner.uid,71);assert.equal(f.session.wallet,wallet);
  const other={...f.ctx,session:{userId:72,wallet:1000000}};
  owner.enter(other,{vipTableMode:0});assert.equal(f.table.baccaratOwner.uid,71);
  assert.equal(f.game.placeBet(other,{params:[{areaId:1,total:100}]}),false);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),true);
  assert.equal(owner.snapshot(f.table).hostActive,true);
  assert.deepEqual(owner.snapshot(f.table).hostBetAreas,[1]);
  owner.handle(f.ctx,6130,{betTime:30,peekTime:5});
  assert.equal(owner.privilege(f.table).betTime,30);assert.equal(owner.privilege(f.table).activeBetTime,20);
  owner.beforeRound(f.io,f.table);assert.equal(owner.privilege(f.table).activeBetTime,30);
  f.table.shoeHands=30;
  owner.handle(f.ctx,6130,{newShoe:true,bg:999});assert.equal(f.table.shuffleRequested,undefined);
  owner.handle(f.ctx,6130,null);assert.equal(f.table.shuffleRequested,undefined);
  const poor=fixture(4);poor.session.wallet=49999;owner.enter(poor.ctx,{vipTableMode:0});assert.equal(poor.table.baccaratOwner,undefined);
});

test('Baccarat VIP disconnect retains an unsettled owner then releases after settlement', async () => {
  const f=fixture(4);owner.enter(f.ctx,{vipTableMode:0});f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]});
  owner.leave(f.ctx);assert.equal(f.table.baccaratOwner.releasePending,true);
  f.table.lastResult={...rules.winningAreas([3,4],[0,1]),player:[3,4],banker:[0,1]};
  await engine.applyCycle(f.io,f.table,6);engine.applyCycle(f.io,f.table,8);
  assert.equal(f.table.baccaratOwner,null);
});

test('Baccarat VIP early deal never discards bets; repeated peek completion cannot extend deadline', () => {
  const f=fixture(4);owner.enter(f.ctx,{vipTableMode:0});f.table.phaseEndsAt=Date.now()+10000;
  owner.handle(f.ctx,6131,{});assert.equal(f.table.baccaratFlying,true);assert.equal(f.messages.at(-1).data.code,0);
  f.table.baccaratFlying=false;f.table.phaseEndsAt=Date.now()+10000;
  f.game.placeBet(f.ctx,{params:[{areaId:2,total:100}]});
  owner.handle(f.ctx,6131,{});assert.equal(f.table.baccaratFlying,false);assert.equal(f.table.playerBets.get(71)[0].total,100);
  f.table.state=4;f.table.phaseEndsAt=Date.now()+10000;
  owner.handle(f.ctx,6132,{});const end=f.table.phaseEndsAt;owner.handle(f.ctx,6132,{});assert.equal(f.table.phaseEndsAt,end);
  f.game.tickRobots(f.ctx);assert.equal(f.table.hundredRobots,undefined);
});

test('Baccarat production history uses scoped Redis then data-center and verifies ownership', async () => {
  const f=fixture(), cache=new Map(), calls=[];
  const payload={gameRoomId:f.table.roomId,currInning:5,showdownPokers:{other:[1,2],banker:[3,4]},showdownTypes:{other:5,banker:9},winAreaIds:[2,9],betDetailTableMap:{}};
  const row={userId:71,agentId:7,gameId:58,hash:'safe-hash',init:JSON.stringify(payload)};
  const gateway={async getRecords(q){calls.push(['list',q]);return {data:[row,{...row,userId:72,hash:'foreign',init:JSON.stringify({...payload,currInning:6})},{...row,agentId:8,hash:'foreign-agent'}]};},
    async getRecordDetail(q){calls.push(['detail',q]);return {found:true,data:row};}};
  f.ctx.runtime={env:'prod',rpc:{gateway,bus:{async getCache(k){return cache.get(k)},async setCache(k,value,ttl){assert.ok(k.startsWith('baccarat:7:700001:'));assert.ok([30,300].includes(ttl));cache.set(k,value)}}}};
  assert.deepEqual((await history.list(f.ctx)).list,[5]);await history.list(f.ctx);
  assert.equal(calls.filter(c=>c[0]==='list').length,1);
  assert.equal(await history.detail(f.ctx,6),null);assert.equal(await history.detail(f.ctx,-1),null);
  assert.deepEqual(await history.detail(f.ctx,5),payload);await history.detail(f.ctx,5);
  assert.equal(calls.filter(c=>c[0]==='detail').length,1);
  const query=calls[0][1];assert.equal(query.size,100);assert.equal(query.page,1);assert.equal(query.endTime-query.startTime,8*3600000);
  f.ctx.session={userId:72};assert.equal(await history.detail(f.ctx,5),null);
  const dev=fixture();history.record(dev.table,{player:[1,2],banker:[3,4],areas:[2],p:5,b:9,settlements:new Map()},new Map([[71,dev.session]]),{env:'prod'});
  assert.equal(dev.table.hundredHistory,undefined);
});

test('Baccarat coalesces concurrent record requests and validates cached detail ownership',async()=>{
  const f=fixture(),payload={gameRoomId:f.table.roomId,currInning:9,showdownPokers:{other:[1,2],banker:[3,4]},showdownTypes:{other:5,banker:9},winAreaIds:[2,9],betDetailTableMap:{}};
  const row={userId:71,agentId:7,gameId:58,hash:'own',init:JSON.stringify(payload)};
  let lists=0,details=0;
  const gateway={async getRecords(){lists++;await new Promise(r=>setTimeout(r,5));return {data:[row]}},
    async getRecordDetail(){details++;await new Promise(r=>setTimeout(r,5));return {found:true,data:{...row,userId:72}}}};
  f.ctx.runtime={env:'prod',rpc:{gateway,bus:{async getCache(){return null},async setCache(){}}}};
  const result=await Promise.all(Array.from({length:20},()=>history.detail(f.ctx,9)));
  assert.equal(lists,1);assert.equal(details,1);assert.ok(result.every(r=>r===null));
  assert.equal(f.table.baccaratRecordDetailTasks.size,0);assert.equal(f.table.baccaratRecordListTasks.size,0);
});
