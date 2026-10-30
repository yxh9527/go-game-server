import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGames } from '../../../game-server/src/games/catalog.js';
import { seedRooms } from '../../../cache/rpc/seed.js';
import { AREA_IDS, winningAreas, roomRules, betNet } from '../../../game-server/src/core/turntable-rules.js';
import { engine, createHand } from '../../../game-server/src/core/turntable-engine.js';
const games = await loadGames('arcade-test');
function fixture(type = 53) {
  const game = games.byRoomType.get(type), row = seedRooms().find(r => r.room_type === type);
  const table = game.createTable(row.game_room_config_id * 10000, type, row);
  const session = { userId: 9, wallet: 1000000 }, messages = [];
  game.enter(table, session);
  const io = { broadcast: (id,data) => messages.push({id,data:structuredClone(data)}),
    sendUser: (uid,id,data) => messages.push({uid,id,data:structuredClone(data)}), forEachPlayer: fn => fn(session) };
  const runtime = { wallet: { debit(s,n) { if(n>s.wallet)return {ok:false}; s.wallet-=n;return {ok:true}; },
    credit(s,n) { s.wallet+=n; return {ok:true}; } } };
  const ctx = { table, session, io, runtime, send:(id,data)=>io.sendUser(9,id,data) };
  engine.beginRound(io, table, Date.now(), () => 0);
  return { game,table,session,messages,ctx };
}
test('all wheel outcomes have exactly two normal wins and complementary reverse bets', () => {
  for(let outer=1;outer<=4;outer++)for(let inner=1;inner<=3;inner++) {
    const wins=winningAreas(outer,inner); assert.equal(wins.length,15);
    assert.deepEqual(wins.slice(0,2),[(inner-1)*4+outer,12+inner]);
    for(let id=1;id<=15;id++)assert.notEqual(wins.includes(id),wins.includes(id+15));
    assert.equal(new Set(wins).size,15);
  }
  assert.throws(()=>winningAreas(0,1));
});
test('decimal odds settle integer points accurately', () => {
  assert.equal(betNet({winningAreas:[19]},{areaId:19,total:100},{19:0.29}),29);
  assert.equal(betNet({winningAreas:[24]},{areaId:24,total:1000},{24:0.003}),3);
  assert.equal(betNet({winningAreas:[]},{areaId:24,total:1000},{24:0.003}),-1000);
});
for(const type of [53,54,55,56,57]) {
  test('arcade '+type+' identity, tracks, 30 odds, result/history, frozen prices and idempotent payout', async () => {
    const {game,table,session,messages,ctx}=fixture(type),rules=table.rules;
    assert.equal(game.kind,'hundred');assert.equal(table.state,2);
    assert.equal(game.config.name,rules.gameName);
    assert.equal(rules.defaultOuter.length,24);assert.equal(rules.defaultInner.length,24);
    const conf=game.buildConf(table);assert.equal(conf[rules.key+'Params'].gameRoomConfigId,type+50);
    const snapshot=game.enterSnapshot(table,session);assert.equal(Object.keys(snapshot.areaOdds).length,30);
    assert.equal(snapshot.winningAreas,undefined,'future result is hidden during betting');
    for(const id of AREA_IDS)assert.equal(typeof snapshot.hundredParams.betAreaOdds[id].odds,'number');
    const bets=AREA_IDS.map(areaId=>({areaId,total:1000}));
    assert.equal(game.placeBet(ctx,{roomType:type,params:bets}),true);
    const expected=1000000+bets.reduce((n,b)=>n+betNet(table.hand,b,table.hand.areaOdds),0);
    rules.betAreaOdds={...rules.betAreaOdds,1:999};
    await engine.settleRound(ctx);await engine.settleRound(ctx);
    assert.equal(session.wallet,expected);assert.equal(table.state,6);
    assert.ok(table.phaseEndsAt-Date.now()>14000,'allow original wheel stop and payout animation');
    const result=messages.findLast(m=>m.id===6208).data;
    assert.equal(result.outerValue,rules.defaultOuter[result.outerIndex]);
    assert.equal(result.innerValue,rules.defaultInner[result.innerIndex]);
    assert.deepEqual([...result.winningAreas,...result.lostAreas].sort((a,b)=>a-b),AREA_IDS);
    assert.equal(result.points,expected);assert.equal(Object.keys(result.areaWinningScores).length,30);
    const detail=engine.historyDetail(table,9,1);assert.equal(detail.innerValue,result.innerValue);
    assert.equal(detail.outerValue,result.outerValue);assert.equal(Object.keys(detail.areaOdds).length,30);
    assert.equal(Object.keys(detail.betDetailTableMap).length,30);assert.equal(engine.historyDetail(table,10,1),null);
    assert.equal(table.ways[1].ways.length,1);assert.equal(table.ways[2].ways.length,1);
    const loaded=await loadGames('arcade-reload-'+type);const updated=loaded.byRoomType.get(type);
    assert.equal(updated.enterSnapshot(table,session).points,expected);
    assert.equal(updated.enterSnapshot(table,session).inning,1);
    engine.tick(ctx.io,table,table.phaseEndsAt+1,ctx);assert.equal(table.state,10);
    engine.tick(ctx.io,table,table.phaseEndsAt+1,ctx);engine.tick(ctx.io,table,table.phaseEndsAt+1,ctx);
    engine.tick(ctx.io,table,Date.now(),ctx);assert.equal(table.inning,2);assert.equal(table.state,2);
    assert.equal(table.playerBets.size,0);assert.equal(session.wallet,expected);
  });
}
test('malformed bets, expired countdown, wrong room and reverse minimum do not debit', () => {
  const {game,table,session,ctx}=fixture(56);
  for(const total of [NaN,Infinity,-1,0,0.5])assert.equal(game.placeBet(ctx,{roomType:56,params:[{areaId:1,total}]}),false);
  assert.equal(game.placeBet(ctx,{roomType:56,roomId:1,params:[{areaId:1,total:100}]}),false);
  assert.equal(game.placeBet(ctx,{roomType:56,params:[{areaId:24,total:100}]}),false);
  table.phaseEndsAt=Date.now()-1;
  assert.equal(game.placeBet(ctx,{roomType:56,params:[{areaId:1,total:100}]}),false);
  assert.equal(session.wallet,1000000);
});
test('cancel refunds only owned selected areas once and blocks payout until asynchronous refund completes', async () => {
  const f=fixture();assert.equal(f.game.placeBet(f.ctx,{roomType:53,params:[{areaId:1,total:100},{areaId:2,total:200}]}),true);
  let complete;f.ctx.runtime.wallet.credit=(s,n)=>new Promise(resolve=>{complete=()=>{s.wallet+=n;resolve({ok:true});};});
  const task=f.game.onMessage(f.ctx,6111,{roomType:53,areaIds:[1,1]});await Promise.resolve();
  assert.equal(f.game.placeBet(f.ctx,{roomType:53,params:[{areaId:1,total:100}]}),false);
  assert.equal(await engine.settleRound(f.ctx),false);
  complete();await task;assert.equal(f.session.wallet,999800);
  assert.deepEqual(f.table.playerBets.get(9),[{areaId:2,total:200}]);assert.equal(f.table.totalBetsByArea[1],0);
  await f.game.onMessage(f.ctx,6111,{roomType:53,areaIds:[1]});assert.equal(f.session.wallet,999800);
});
test('failed payout retries remaining wallets without paying completed wallets twice', async () => {
  const f=fixture();f.game.placeBet(f.ctx,{roomType:53,params:[{areaId:1,total:100} ]});
  let attempts=0;f.ctx.runtime.wallet.credit=(s,n)=>{if(++attempts===1)return {ok:false};s.wallet+=n;return {ok:true};};
  await assert.rejects(()=>engine.settleRound(f.ctx),/credit rejected/);
  assert.equal(f.table.hand.settled,undefined);assert.equal(f.session.wallet,999900);
  await engine.settleRound(f.ctx);await engine.settleRound(f.ctx);
  assert.equal(f.session.wallet,1003500);assert.equal(attempts,2);
});
test('configuration rejects invalid tracks and odds instead of emitting NaN', () => {
  for(const value of [NaN,Infinity,-1,0.0001])assert.throws(()=>roomRules({room_type:53,payload:{betAreaOdds:{1:value}}}),/odds/);
  assert.throws(()=>roomRules({room_type:54,payload:{defaultInner:[1]}}),/track/);
  for(const type of [53,54,55,56,57])for(const r of [0,0.1,0.5,0.999999]) {
    const f=fixture(type),hand=createHand(f.table,()=>r);
    assert.ok(hand.outerIndex>=0&&hand.outerIndex<24);assert.ok(hand.innerIndex>=0&&hand.innerIndex<24);
  }
});
