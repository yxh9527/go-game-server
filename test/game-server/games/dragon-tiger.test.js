import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DragonTigerGame } from '../../../game-server/src/games/dragon-tiger/DragonTigerGame.js';
import { BaccaratGame } from '../../../game-server/src/games/baccarat/BaccaratGame.js';
import config from '../../../game-server/src/games/dragon-tiger/config.js';
import * as rules from '../../../game-server/src/games/dragon-tiger/rules.js';
import * as pricing from '../../../game-server/src/games/dragon-tiger/odds.js';
import * as engine from '../../../game-server/src/games/dragon-tiger/engine.js';
import * as owner from '../../../game-server/src/core/hundred-table-owner.js';
import * as history from '../../../game-server/src/core/hundred-card-history.js';
import { hundredLobbySnapshot } from '../../../game-server/src/core/hundred-lobby.js';
import { createRoomLogic } from '../../../hall/src/rooms.js';
import { seedRooms } from '../../../cache/rpc/seed.js';
import * as decode from '../../../hall/src/decode.js';

function fixture(mode = 0) {
  const game = new DragonTigerGame(), table = game.createTable(1720003, 59, {
    game_room_config_id: 172, play_mode: mode, room_index: 3, robot_behavior: { enabled: false },
  });
  table.agentId = 7;
  const messages = [], credits = [], session = { userId: 71, wallet: 1000000, name: 'tester' };
  const wallet = { debit(s, n) { if (s.wallet < n) return { ok: false }; s.wallet -= n; return { ok: true }; },
    credit(s, n) { credits.push(n); s.wallet += n; return { ok: true }; }, async persist() {} };
  const io = { wallet, broadcast(id, data) { messages.push({ id, data: structuredClone(data) }); },
    sendUser(uid, id, data) { messages.push({ uid, id, data: structuredClone(data) }); }, forEachPlayer(fn) { fn(session); } };
  const ctx = { table, session, io, runtime: { wallet, env: 'dev' }, send: (id, data) => io.sendUser(71, id, data) };
  game.enter(table, session);
  return { game, table, ctx, io, wallet, session, messages, credits };
}
function fixed(f, dragon, tiger) {
  f.table.preparedHand = null;
  f.table.deck = [dragon, tiger, ...Array.from({ length: 52 }, (_, i) => i).filter(i => i !== dragon && i !== tiger)];
  f.table.deckPos = 0; engine.prepareHand(f.io, f.table);
}

function nativeMultiRoomRenderer(mode) {
  const source = fs.readFileSync(new URL('../../../static/client/2.0.1279/assets/Hundred/index.cb4b3.js', import.meta.url), 'utf8');
  const moduleStart = source.indexOf("'HundredHaoluRoom':[function(");
  assert.ok(moduleStart > 0);
  const start = source.indexOf("['setSettleResultPoints']=function", moduleStart) + "['setSettleResultPoints']=".length;
  const end = source.indexOf('return this;}', start) + 'return this;}'.length;
  const render = vm.runInNewContext('(' + source.slice(start, end) + ')', {
    E: { HundredDef: { PlayMode: { Bjl_MingPai: 3 } } },
    I: { default: { getLangTextFmt: (_group, _key, point) => String(point) } }, cc: { Label: 'Label' },
  });
  const labels = { pointsLb1: { string: '' }, pointsLb2: { string: '' } };
  const wins = { 1: { active: false }, 2: { active: false } };
  const target = {
    _task: { clear() {} }, _isReconnect: true, playMode: mode, pokersPanel: { active: true },
    settleResultPanel: { active: false, getChildByName(name) {
      return name === 'winSpines' ? { children: Object.values(wins), getChildByName: key => wins[key] }
        : { getComponent: () => labels[name] };
    } }, areaWinAnimMap: new Map([[1, wins[1]], [2, wins[2]]]),
  };
  return { render: data => render.call(target, data), labels };
}

test('Dragon Tiger projects all multi-room surfaces for the unmodified native point renderer', async () => {
  for (const mode of [0, 1, 3, 4]) {
    const f = fixture(mode); fixed(f, 12, 0); f.table.state = 2;
    assert.equal(f.game.placeBet(f.ctx, { params: [{ areaId: 1, total: 100 }] }), true);
    engine.applyCycle(f.io, f.table, 4); await engine.applyCycle(f.io, f.table, 6);
    const main = f.game.enterSnapshot(f.table, f.session);
    const personal = f.messages.find(m => m.id === 6208 && m.uid === 71).data;
    assert.deepEqual(main.showdownPoints, { dragon: [13], tiger: [1] });
    assert.deepEqual(personal.showdownPoints, main.showdownPoints);
    const renderer = nativeMultiRoomRenderer(mode);
    assert.throws(() => renderer.render(main), /length/); // Reproduce the reported client exception.
    f.game.pushState(f.ctx);
    const multi = [f.game.multiRoomSnapshot(f.table, f.session), f.game.siblingRoomPayload(f.table),
      f.messages.find(m => m.id === 6229 && m.uid === 71).data,
      f.messages.findLast(m => m.id === 6228).data];
    for (const payload of multi) {
      assert.equal(Object.hasOwn(payload, 'showdownPoints'), false);
      assert.deepEqual(payload.showdownTypes, { dragon: 13, tiger: 1 });
      assert.deepEqual(payload.showdownPokers, { dragon: [12], tiger: [0] });
      assert.doesNotThrow(() => renderer.render(payload));
      assert.equal(renderer.labels.pointsLb1.string, '13');
      assert.equal(renderer.labels.pointsLb2.string, '1');
    }
    assert.deepEqual(f.game.enterSnapshot(f.table, f.session).showdownPoints, main.showdownPoints);
    engine.applyCycle(f.io, f.table, 7);
    assert.doesNotThrow(() => renderer.render(f.game.multiRoomSnapshot(f.table, f.session)));
    engine.applyCycle(f.io, f.table, 8);
    assert.equal(f.game.multiRoomSnapshot(f.table, f.session).showdownTypes, undefined);
  }
});

test('Baccarat multi-room fallback retains the native other/banker point arrays', () => {
  const game = new BaccaratGame(), table = game.createTable(1400001, 58, { play_mode: 0, room_index: 1 });
  const main = game.enterSnapshot(table, { userId: 71, wallet: 1000 });
  assert.deepEqual(game.multiRoomSnapshot(table, { userId: 71, wallet: 1000 }), main);
  table.state = 6;
  table.lastResult = { player: [0, 1], banker: [2, 3], p: 3, b: 7, areas: [2] };
  const snapshot = game.multiRoomSnapshot(table, { userId: 71, wallet: 1000 });
  assert.deepEqual(snapshot.showdownPoints, { other: [3], banker: [7] });
  const renderer = nativeMultiRoomRenderer(0);
  assert.doesNotThrow(() => renderer.render(snapshot));
  assert.equal(renderer.labels.pointsLb1.string, '3');
  assert.equal(renderer.labels.pointsLb2.string, '7');
});

test('Dragon Tiger catalog uses the five captured tables and all four native modes', () => {
  const logic = createRoomLogic(decode), rows = seedRooms(), selected = logic.filterRooms(rows, { gameType: 1003 });
  assert.equal(selected.length, 5); assert.deepEqual([...new Set(selected.map(r => r.play_mode))].sort(), [0,1,3,4]);
  for (const row of selected) {
    assert.equal(row.room_type, 59);
    assert.equal(logic.findRoom(rows, { roomType: 59, playMode: row.play_mode, roomIndex: row.room_index }), row);
    const data = JSON.parse(row.payload); assert.ok(data.brlhdParams); assert.equal(data.hundredGame, 1);
  }
  assert.equal(logic.findRoom(rows, { roomType: 59, playMode: 4, roomIndex: 999 }), null);
  assert.throws(() => fixture(2), /Unsupported/);
});

test('Dragon Tiger evaluates all 2652 distinct card pairs with Ace low and suit independent ties', () => {
  const deck = engine.makeShoe(); assert.equal(deck.length, 52); assert.equal(new Set(deck).size, 52);
  assert.throws(() => engine.makeShoe(8));
  for (let d=0;d<52;d++) for (let t=0;t<52;t++) if (d !== t) {
    const a=rules.winningAreas(d,t), dp=d%13+1,tp=t%13+1;
    assert.equal(a.result,dp===tp?0:dp>tp?1:2); assert.equal(a.areas[0],a.result||3);
    assert.equal(a.areas[1],dp%2?4:5); assert.equal(a.areas[2],Math.floor(d/13)%2?7:6);
    assert.equal(a.areas[3],tp%2?8:9); assert.equal(a.areas[4],Math.floor(t/13)%2?11:10);
    assert.equal(a.areas.includes(15),dp!==tp);
  }
  for (const bad of [-1,52,NaN,null,'0',1.5]) assert.throws(() => rules.point(bad));
});

test('Dragon Tiger bright sum regions include every boundary exactly once', () => {
  for (let d=0;d<52;d++) for (let t=0;t<52;t++) if(d!==t) {
    const result=rules.winningAreas(d,t,3), sum=rules.point(d)+rules.point(t);
    assert.equal(result.areas[1],sum<=9?12:sum<=18?13:14);
    assert.equal(result.areas.some(id=>id>=4&&id<=11),false);
  }
});

test('Dragon Tiger all twelve standard prices match native help', () => {
  assert.deepEqual(Object.values(pricing.configuredOdds(config)).map(p=>p.oddsList[0]),
    [100,100,800,81,111,95,95,81,111,95,95,7]);
  for (const p of Object.values(pricing.configuredOdds(config))) assert.equal(p.odds,p.oddsList[0]/100);
});

test('Dragon Tiger fair bright prices depend on public composition, not hidden card order', () => {
  const deck=Array.from({length:52},(_,i)=>i), quote=pricing.brightOdds(deck,5);
  assert.deepEqual(quote,pricing.brightOdds(deck.slice().reverse(),5));
  assert.deepEqual(Object.keys(quote).map(Number),[1,2,3,12,13,14,15]);
  for(const item of Object.values(quote))assert.ok(Number.isSafeInteger(item.oddsList[0])&&item.oddsList[0]>=0);
  const ace=pricing.brightOdds(deck,0);assert.equal(ace[1].oddsList[0],0);assert.ok(ace[2].oddsList[0]>0);
  assert.throws(()=>pricing.brightOdds([1,2],0));
});

test('Dragon Tiger tie returns half of main stakes, pays tie and settles side bets independently', async () => {
  const f=fixture(); fixed(f,0,13); const initial=f.session.wallet;
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100},{areaId:2,total:100},
    {areaId:3,total:100},{areaId:4,total:100},{areaId:10,total:100},{areaId:15,total:100}]}),true);
  engine.applyCycle(f.io,f.table,4); await engine.applyCycle(f.io,f.table,6);
  assert.equal(f.session.wallet,initial-50-50+800+81-100-100);
  assert.equal(f.credits.length,1);
  const detail=await history.detail(f.ctx,1);
  assert.deepEqual(detail.showdownPokers,{dragon:[0],tiger:[13]});assert.deepEqual(detail.showdownTypes,{dragon:1,tiger:1});
  assert.equal(detail.betDetailTableMap[1].realScore,-50);
});

test('Dragon Tiger credits are not repeated after persistence failure or concurrent retries', async () => {
  const f=fixture();fixed(f,12,0);f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]});
  engine.applyCycle(f.io,f.table,4);let calls=0;
  f.wallet.persist=async()=>{if(++calls===1)throw new Error('storage offline');};
  await assert.rejects(engine.applyCycle(f.io,f.table,6),/storage offline/);
  assert.equal(f.table.lastResult.settled,undefined);assert.throws(()=>engine.applyCycle(f.io,f.table,8),/unsettled/);
  await Promise.all(Array.from({length:10},()=>engine.applyCycle(f.io,f.table,6)));
  assert.equal(f.credits.length,1);assert.equal(f.session.wallet,1000100);
  assert.equal(f.messages.filter(m=>m.id===6210).length,1);
});

test('Dragon Tiger failed wallet credit retries without marking the hand settled', async () => {
  const f=fixture();fixed(f,12,0);f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]});engine.applyCycle(f.io,f.table,4);
  const original=f.wallet.credit;f.wallet.credit=()=>({ok:false});
  await assert.rejects(engine.applyCycle(f.io,f.table,6),/payout rejected/);assert.equal(f.table.lastResult.settled,undefined);
  f.wallet.credit=original;await engine.applyCycle(f.io,f.table,6);assert.equal(f.session.wallet,1000100);
});

test('Dragon Tiger malformed batches, cumulative limits, wrong rooms and expired clock never partially debit', () => {
  const f=fixture();f.table.cfg.hundred_max_bet=200;
  for(const body of [null,[],true,'bad'])assert.equal(f.game.placeBet(f.ctx,body),false);
  for(const params of [[],[{areaId:1,total:100},{areaId:2,total:NaN}], [{areaId:1,total:-100}],
    [{areaId:99,total:100}],[{areaId:1,total:100.5}],[{areaId:1,total:Number.MAX_SAFE_INTEGER}]]) {
    assert.equal(f.game.placeBet(f.ctx,{params}),false);assert.equal(f.session.wallet,1000000);
  }
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}],roomId:99}),false);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}],roomType:58}),false);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),true);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:200}]}),false);assert.equal(f.session.wallet,999900);
  f.table.phaseEndsAt=Date.now()-1;assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:2,total:100}]}),false);
});

test('Dragon Tiger frozen quotes, public Dragon only and raw deck isolation survive configuration changes', async () => {
  const f=fixture(3);fixed(f,5,0);f.game.tick(f.ctx);
  const before=engine.currentOdds(f.table)[1].oddsList[0], snap=f.game.enterSnapshot(f.table,f.session);
  assert.equal(snap.deck,undefined);assert.equal(snap.preparedHand,undefined);assert.equal(snap.showdownPokers,undefined);
  assert.deepEqual(snap.bankerShowPoker,[5]);assert.deepEqual(snap.bankerCards,[5]);assert.ok(snap.countDown>0);
  const hall=JSON.parse(hundredLobbySnapshot(f.game,f.table).extendInfo);
  assert.equal(hall.showdownPokers,undefined);assert.equal(hall.deck,undefined);
  f.table.state=2;assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),true);
  f.table.config={...config,odds:{1:999}};engine.applyCycle(f.io,f.table,4);
  await engine.applyCycle(f.io,f.table,6);assert.equal(f.session.wallet,1000000+before);
  const pos=f.table.deckPos;engine.applyCycle(f.io,f.table,4);assert.equal(f.table.deckPos,pos);
});

test('Dragon Tiger zero conditional prices are unavailable to humans and robots', () => {
  const f=fixture(3);fixed(f,0,12);f.table.state=2;
  assert.equal(f.game.betOptions(f.table).areas.some(a=>a.areaId===1),false);
  assert.equal(f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]}),false);
  assert.equal(f.session.wallet,1000000);
});

test('Dragon Tiger shared state clock progresses all four modes and shuffles without replaying a hand', async () => {
  for(const mode of [0,1,3,4]) {
    const f=fixture(mode);f.game.tick(f.ctx);assert.ok(f.table.phaseEndsAt>Date.now());
    const phases=engine.phasesFor(f.table);assert.equal(phases[0].state,mode===3?1:2);
    const initial=f.table.inning, states=[];
    for(let i=0;i<12&&f.table.inning===initial;i++) {f.table.phaseEndsAt=Date.now()-1;await f.game.tick(f.ctx);states.push(f.table.state);}
    assert.equal(f.table.inning,initial+1);for(const state of [2,3,4,6,7,0])if(state!==2||mode===3)assert.ok(states.includes(state));
    assert.equal(f.table.lastResult,null);assert.equal(f.table.playerBets.size,0);
  }
  const f=fixture();f.table.deckPos=50;f.table.ways[1]=[{result:1,winArea:[1]}];
  assert.equal(engine.phasesFor(f.table).find(p=>p.cycle===80).skip,false);
  engine.applyCycle(f.io,f.table,80);assert.equal(f.table.deckPos,0);assert.equal(f.table.remainCardsNum,52);
  assert.deepEqual(f.table.ways[1],[]);assert.equal(new Set(f.table.deck).size,52);
});

test('Dragon Tiger owner claims are free, allow other bets, fly still settles and appearance applies next round', async () => {
  const f=fixture(4), before=f.session.wallet;owner.enter(f.ctx,{vipTableMode:1});assert.equal(f.table.baccaratOwner,undefined);
  owner.enter(f.ctx,{vipTableMode:0});assert.equal(f.session.wallet,before);assert.equal(owner.snapshot(f.table).hostUid,71);
  assert.equal(owner.privilege(f.table).remainDealerBgTime,0);
  owner.handle(f.ctx,6130,{dealer:401,bg:60,betTime:10,peekTime:5});
  assert.equal(owner.privilege(f.table).dealer,401);assert.equal(owner.privilege(f.table).activeDealer,301);
  const guest={userId:72,wallet:1000000}, guestCtx={...f.ctx,session:guest};f.game.enter(f.table,guest);
  assert.equal(f.game.placeBet(guestCtx,{params:[{areaId:1,total:100}]}),true);
  f.table.phaseEndsAt=Date.now()+10000;owner.handle(f.ctx,6131,{});assert.equal(f.table.baccaratFlying,false);
  engine.applyCycle(f.io,f.table,4);await engine.applyCycle(f.io,f.table,6);engine.applyCycle(f.io,f.table,8);
  assert.equal(owner.privilege(f.table).activeDealer,401);assert.equal(owner.privilege(f.table).activeBg,60);
  f.game.tickRobots(f.ctx);assert.equal(f.table.hundredRobots,undefined);
});

test('Dragon Tiger leaving retains unsettled bettors and history previous/next is room and player scoped', async () => {
  const f=fixture();fixed(f,12,0);f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]});f.game.onLeave(f.ctx);
  assert.ok(f.table.playerSessions.has(71));assert.equal(f.table.visitors.has(71),false);
  engine.applyCycle(f.io,f.table,4);await engine.applyCycle(f.io,f.table,6);assert.equal(f.session.wallet,1000100);
  f.game.enter(f.table,f.session);engine.applyCycle(f.io,f.table,8);fixed(f,0,12);
  f.game.placeBet(f.ctx,{params:[{areaId:2,total:100}]});engine.applyCycle(f.io,f.table,4);await engine.applyCycle(f.io,f.table,6);
  assert.deepEqual((await history.list(f.ctx)).list,[1,2]);
  assert.deepEqual((await history.detail(f.ctx,1)).showdownPokers,{dragon:[12],tiger:[0]});
  assert.deepEqual((await history.detail(f.ctx,2)).showdownPokers,{dragon:[0],tiger:[12]});
  assert.equal(await history.detail({...f.ctx,session:{userId:999}},1),null);
});

test('Dragon Tiger production review uses Redis then data-center with type59 and validates ownership', async () => {
  const f=fixture(), cache=new Map(), calls=[];
  const payload={gameRoomId:f.table.roomId,currInning:5,showdownPokers:{dragon:[0],tiger:[12]},
    showdownTypes:{dragon:1,tiger:13},winAreaIds:[2,4,6,8,11,15],betDetailTableMap:{}};
  const row={userId:71,agentId:7,gameId:59,hash:'lhd-safe',init:JSON.stringify(payload)};
  const gateway={async getRecords(q){calls.push(['list',q]);return {data:[row,{...row,userId:72,hash:'foreign'}]};},
    async getRecordDetail(q){calls.push(['detail',q]);return {found:true,data:row};}};
  f.ctx.runtime={env:'prod',rpc:{gateway,bus:{async getCache(k){return cache.get(k)},async setCache(k,value,ttl){
    assert.ok(k.startsWith('dragon-tiger:7:1720003:'));assert.ok([30,300].includes(ttl));cache.set(k,value);}}}};
  assert.deepEqual((await history.list(f.ctx)).list,[5]);
  const details=await Promise.all(Array.from({length:20},()=>history.detail(f.ctx,5)));assert.ok(details.every(d=>d.currInning===5));
  assert.equal(calls.filter(c=>c[0]==='list').length,1);assert.equal(calls.filter(c=>c[0]==='detail').length,1);
  assert.equal(calls[0][1].gameId,59);assert.equal(await history.detail({...f.ctx,session:{userId:72}},5),null);
});

test('Dragon Tiger public robot bets and payouts use independent bankrolls without inspecting hidden cards', async () => {
  const f=fixture();fixed(f,12,0);f.table.cfg.robot_behavior={enabled:true,initialRobots:1,targetRobots:1,
    maxRobots:1,participationProbability:1,maxBetsPerRound:1,betMinMs:1000,betMaxMs:1000};
  const now=Date.now();f.table.phaseEndsAt=now+15000;
  const secret=f.table.deck;Object.defineProperty(f.table,'deck',{configurable:true,get(){throw new Error('robot read hidden deck');}});
  f.game.tickRobots(f.ctx,now,()=>0);f.game.tickRobots(f.ctx,now+1001,()=>0);
  const profile=[...f.table.hundredRobots.profiles.values()][0], uid=profile.session.userId;
  assert.deepEqual(f.table.playerBets.get(uid),[{areaId:1,total:100}]);assert.equal(f.session.wallet,1000000);
  Object.defineProperty(f.table,'deck',{configurable:true,writable:true,value:secret});
  engine.applyCycle(f.io,f.table,4);await engine.applyCycle(f.io,f.table,6);
  assert.equal(profile.session.wallet,profile.openingWallet+100);assert.equal(f.credits.length,0);
  assert.ok(f.messages.some(m=>m.id===6202&&m.data.allPlayerBets.find(a=>a.areaId===1).total===100));
  assert.ok(f.messages.filter(m=>m.id===6208&&m.uid===71).every(m=>m.data.realScore===0));
});

test('Dragon Tiger versioned reload keeps frozen cards, prices, records and original deadline', async () => {
  const f=fixture(3);fixed(f,5,0);f.game.tick(f.ctx);
  const hand=f.table.preparedHand, deadline=f.table.phaseEndsAt, price=engine.currentOdds(f.table);
  const next=await import('../../../game-server/src/games/dragon-tiger/DragonTigerGame.js?v=lhd-hot-test');
  const reloaded=new next.DragonTigerGame();reloaded.tick(f.ctx);
  assert.equal(f.table.preparedHand,hand);assert.equal(f.table.phaseEndsAt,deadline);
  assert.deepEqual(engine.currentOdds(f.table),price);assert.equal(f.table.deckPos,0);
  f.table.state=2;f.game.placeBet(f.ctx,{params:[{areaId:1,total:100}]});
  reloaded.engine.applyCycle(f.io,f.table,4);await reloaded.engine.applyCycle(f.io,f.table,6);
  assert.equal((await history.list(f.ctx)).list.length,1);assert.equal(f.credits.length,1);
});
