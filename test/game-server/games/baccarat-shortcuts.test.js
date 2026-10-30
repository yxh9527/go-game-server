import test from 'node:test';
import assert from 'node:assert/strict';
import { BaccaratGame } from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import { applyCycle } from '../../../game-server/src/games/baccarat/engine.js';
import { drawBaccarat } from '../../../game-server/src/games/baccarat/rules.js';

function fixture() {
  const game = new BaccaratGame(), table = game.createTable(58030001, 58, { hundred_max_bet: 1000, robot_behavior: { enabled: false } });
  const session = { userId: 17, wallet: 10000 }, messages = [], credits = [];
  const io = { wallet: { debit(s,n) { s.wallet -= n; return { ok:true }; },
    credit(s,n) { credits.push(n); s.wallet += n; return { ok:true }; } },
    broadcast(id,data) { messages.push({ id, data: structuredClone(data) }); },
    sendUser(uid,id,data) { messages.push({ uid,id,data: structuredClone(data) }); },
    forEachPlayer(fn) { fn(session); } };
  const ctx = { table, session, io, runtime: { wallet: io.wallet }, send: (id,data)=>io.sendUser(17,id,data) };
  game.enter(table,session);
  const bet = params => game.placeBet(ctx,{ roomType:58,roomId:table.roomId,customData:2,params },6226);
  return { game, table, session, io, ctx, credits, messages, bet };
}

test('Baccarat shortcuts reject malformed batches, cumulative limits and expired clocks before debit',()=>{
  const f=fixture();
  for(const params of [[{areaId:1,total:100},{areaId:999,total:100}], [{areaId:1,total:NaN}],
    [{areaId:1,total:1.5}], [{areaId:1,total:-100}], [{areaId:1,total:600},{areaId:1,total:600}]])assert.equal(f.bet(params),false);
  assert.equal(f.session.wallet,10000);assert.equal(f.table.playerBets.size,0);
  assert.equal(f.bet([{areaId:1,total:900}]),true);assert.equal(f.bet([{areaId:1,total:200}]),false);
  f.table.phaseEndsAt=Date.now()-1;assert.equal(f.bet([{areaId:2,total:100}]),false);
  assert.equal(f.session.wallet,9100);assert.equal(f.messages.at(-1).id,6226);
});

test('Baccarat follows original X=1 Z=2 pairs and prices, with array road results and a valid no-good-road object',()=>{
  const f=fixture();f.table.deck=[0,1,26,39,6];f.table.remainCardsNum=5;f.table.config={...f.table.config,reshuffleAt:0};
  // Use a full deterministic shoe to avoid the low-shoe reshuffle. Player natural 9, banker pair of Aces.
  f.table.deck=[3,4,26,39,...Array(50).fill(9)];f.table.remainCardsNum=54;
  applyCycle(f.io,f.table,4);assert.ok(f.table.lastResult.areas.includes(1));assert.ok(f.table.lastResult.areas.includes(5));
  assert.ok(!f.table.lastResult.areas.includes(2));
  const snap=f.game.enterSnapshot(f.table,f.session);
  assert.equal(snap.areaOdds[1].oddsList[0],100);assert.equal(snap.areaOdds[2].oddsList[0],95);
  assert.equal(snap.ways[9].type,16384);assert.ok(Array.isArray(snap.ways[1].ways[0].winArea));
});

test('Baccarat tie refunds main stakes, settles side bets independently and sends one personal shortcut result',async()=>{
  const f=fixture();f.bet([{areaId:1,total:100},{areaId:2,total:100},{areaId:3,total:100},{areaId:4,total:100}]);
  f.table.lastResult={player:[0,1],banker:[13,14],p:3,b:3,areas:[3]};
  await applyCycle(f.io,f.table,6);await applyCycle(f.io,f.table,6);
  assert.equal(f.session.wallet,10700);assert.deepEqual(f.credits,[1100]);
  const result=f.messages.filter(m=>m.id===6229);assert.equal(result.length,1);
  assert.deepEqual(result[0].data.areaWinningScores,{1:0,2:0,3:800,4:-100});
  assert.equal(result[0].data.realScore,700);
});

test('Baccarat payout retries and concurrent calls retain per-user progress without duplicate credit',async()=>{
  const f=fixture(),peer={userId:18,wallet:9900};f.bet([{areaId:1,total:100}]);
  f.table.playerSessions.set(18,peer);f.table.playerBets.set(18,[{areaId:1,total:100}]);
  f.table.lastResult={player:[3,4],banker:[0,1],p:9,b:3,areas:[1]};
  const attempts=[];let fail=true;const credit=f.io.wallet.credit;
  f.io.wallet.credit=async(s,n)=>{attempts.push(s.userId);if(s.userId===18&&fail)return {ok:false};return credit(s,n);};
  await assert.rejects(Promise.all([applyCycle(f.io,f.table,6),applyCycle(f.io,f.table,6)]),/payout rejected/);
  assert.deepEqual(attempts,[17,18]);assert.equal(f.session.wallet,10100);assert.equal(peer.wallet,9900);
  fail=false;await applyCycle(f.io,f.table,6);assert.deepEqual(attempts,[17,18,18]);
  assert.equal(peer.wallet,10100);assert.equal(f.table.lastResult.settled,true);
  assert.equal(f.messages.filter(m=>m.id===6229&&m.uid===17).length,1);
});

test('Baccarat clocks survive hot replacement, clear old chips through STARTING and adopt new prices only next round',async()=>{
  const f=fixture();f.game.tick(f.ctx);const until=f.table.phaseEndsAt;
  const next=new BaccaratGame();next.config={...next.config,odds:{...next.config.odds,1:1.1}};
  next.tick(f.ctx);assert.equal(f.table.phaseEndsAt,until);assert.equal(f.game.enterSnapshot(f.table,f.session).areaOdds[1].oddsList[0],100);
  f.table.hundredPhaseIndex=4;f.table.state=7;f.table.phaseEndsAt=Date.now()-1;
  next.tick(f.ctx);assert.equal(f.table.state,0);
  f.table.phaseEndsAt=Date.now()-1;next.tick(f.ctx);assert.equal(f.table.state,2);
  assert.equal(next.enterSnapshot(f.table,f.session).areaOdds[1].oddsList[0],110);
});

test('failed payout holds the phase across hot replacement and a slow retry preserves the full animation window',async t=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);
  const f=fixture();f.bet([{areaId:1,total:100}]);
  f.table.lastResult={player:[3,4],banker:[0,1],p:9,b:3,areas:[1]};
  f.table.state=4;f.table.hundredPhaseIndex=2;f.table.phaseEndsAt=now-1;
  f.io.wallet.credit=()=>({ok:false});
  await assert.rejects(f.game.tick(f.ctx),/payout rejected/);
  assert.equal(f.table.hundredPhaseIndex,2);assert.equal(f.table.lastResult.settled,undefined);
  assert.equal(f.table.inning,1);assert.equal(f.session.wallet,9900);
  f.io.wallet.credit=async(s,n)=>{now+=5000;s.wallet+=n;return {ok:true};};
  const reloaded=new BaccaratGame();await reloaded.tick(f.ctx);
  assert.equal(f.table.hundredPhaseIndex,3);assert.equal(f.table.state,6);
  assert.equal(f.table.phaseEndsAt,now+3000);assert.equal(f.session.wallet,10100);
  reloaded.tick(f.ctx);assert.equal(f.table.inning,1);assert.equal(f.session.wallet,10100);
});

test('encoded Ace zero is still a real third card and cannot trigger the no-third-card banker rule',()=>{
  const hand=drawBaccarat([0,1,2,14,0,8],0);
  assert.deepEqual(hand.player,[0,1,0]);assert.deepEqual(hand.banker,[2,14]);assert.equal(hand.next,5);
});
