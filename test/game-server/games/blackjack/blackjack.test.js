import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { BlackjackGame } from '../../../../game-server/src/games/blackjack/BlackjackGame.js';
import { roomRules } from '../../../../game-server/src/games/blackjack/config.js';
import * as engine from '../../../../game-server/src/games/blackjack/engine.js';
import { evaluate, compare, profit, makeShoe } from '../../../../game-server/src/games/blackjack/hand.js';
import { choose } from '../../../../game-server/src/games/blackjack/robot.js';
import { SEND, PUSH, STATE } from '../../../../game-server/src/games/blackjack/messages.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';
import { ranking } from '../../../../game-server/src/core/room-features.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createRoomLogic } from '../../../../hall/src/rooms.js';
import { projectSeatMessage, restoreSeatRequest } from '../../../../game-server/src/core/seat-view.js';

function fixture(deck = [9, 6, 7, 20, 2, 3, 9, 9], members = 1) {
  const game = new BlackjackGame(), table = game.createTable(31010000, 31,
    { game_room_config_id: 3101, ante: 100, carry_min: 500 });
  table.agentId = 7;
  table.members = Array.from({ length: members }, (_, pos) => ({ uid: pos + 1, pos, name: 'p' + pos,
    icon: '1', point: 5000, state: 2, bot: false }));
  table.observers = [{ uid: 99, name: 'watch', icon: '2' }];
  const messages = [], io = { env: 'dev', broadcast: (id, data) => messages.push({ id, data: structuredClone(data) }) };
  engine.begin(io, table, 1000, [...deck, ...makeShoe()]);
  return { game, table, messages, io };
}
function advance(f) { engine.tick(f.io, f.table, f.table.hand.deadline); }
function toPlayer(f) { advance(f); advance(f); if (f.table.hand.state === STATE.INSURANCE) {
  for (const p of f.table.hand.players) engine.act(f.io, f.table, p.uid, SEND.INSURANCE, { buyInsurance: false }, f.table.hand.deadline - 1);
  engine.tick(f.io, f.table, f.table.hand.deadline - 1);
} advance(f); }
function finish(f) {
  for (let i = 0; i < 80 && !f.table.hand.settled; i++) advance(f);
  assert.ok(f.table.hand.settled);
}
test('six-pack shoe and original A/blackjack/five-card/bust priority and 3:2 payout', () => {
  const shoe = makeShoe(); assert.equal(shoe.length, 312);
  for (let i = 0; i < 52; i++) assert.equal(shoe.filter(c => c === i).length, 6);
  assert.deepEqual(evaluate([0, 13, 8]).pointValues, [11, 21]);
  assert.equal(evaluate([0, 9]).handType, 5);
  assert.equal(evaluate([0, 9], true).handType, 3);
  assert.equal(evaluate([0, 1, 2, 3, 4]).handType, 4);
  assert.equal(compare(evaluate([0, 1, 2, 3, 4]), evaluate([9, 10])), 1);
  assert.equal(compare(evaluate([0, 9]), evaluate([0, 1, 2, 3, 4])), 1);
  assert.equal(compare(evaluate([9, 10, 11]), evaluate([9, 10, 11])), -1);
  assert.equal(compare(evaluate([0, 9]), evaluate([13, 22])), 0);
  assert.equal(profit({ cards: [0,9], betAmount: 100 }, [9,8]), 150);
  assert.equal(profit({ cards: [0,1,2,3,4], betAmount: 100 }, [9,8]), 150);
});
test('BET uses raw score units, rejects malformed/duplicate/stale/observer actions without mutation', () => {
  const f = fixture();
  assert.ok(f.game.buildConf(f.table).bj21Params.gameName);
  for (const value of [NaN, Infinity, '100', null, -1, 1.5, 99, 5001])
    assert.equal(engine.act(f.io, f.table, 1, SEND.BET, { betAmount: value }, 1001), false);
  assert.equal(engine.act(f.io, f.table, 99, SEND.BET, { betAmount: 100 }, 1001), false);
  assert.equal(engine.act(f.io, f.table, 1, SEND.BET, { betAmount: 100 }, 1001), true);
  assert.equal(f.table.members[0].point, 4900);
  assert.equal(engine.act(f.io, f.table, 1, SEND.BET, { betAmount: 100 }, 1002), false);
  assert.equal(engine.act(f.io, f.table, 1, SEND.STAND, {}, 1002), false);
  const g = fixture();assert.equal(engine.act(g.io,g.table,1,SEND.BET,{betAmount:100},g.table.hand.deadline),false);
});
test('split/additional wager, double single draw and subsequent-hand turn conserve funds against house', () => {
  const f = fixture([9,6,7,20,2,3,9,9]); toPlayer(f);
  let now = f.table.hand.deadline - 1;
  assert.ok(engine.snapshot(f.table,1).selfAvailableActions.includes('SPLIT'));
  assert.ok(engine.act(f.io,f.table,1,SEND.SPLIT,{},now));
  assert.equal(f.table.hand.players[0].hands.length,2);
  assert.equal(f.table.members[0].point,4800);
  assert.ok(engine.act(f.io,f.table,1,SEND.DOUBLE,{},++now));
  assert.equal(f.table.hand.players[0].hands[0].cards.length,3);
  assert.equal(f.table.hand.players[0].hands[0].betAmount,200);
  assert.equal(f.table.hand.players[0].currentHandIndex,1);
  assert.ok(engine.act(f.io,f.table,1,SEND.STAND,{},++now));
  finish(f);
  assert.equal(f.table.members[0].point+f.table.houseNetScore,5000);
  assert.ok(f.table.members[0].point>=0);
  assert.equal(f.table.hand.results[0].handResults.length,2);
});
test('insurance pays 2:1 profit, dealer blackjack prevents actions, losses cannot spend unavailable funds', () => {
  const f = fixture([0,9,9,8]);advance(f);advance(f);
  assert.equal(f.table.hand.state,STATE.INSURANCE);
  assert.ok(engine.act(f.io,f.table,1,SEND.INSURANCE,{buyInsurance:true},f.table.hand.deadline-1));
  assert.equal(f.table.members[0].point,4850);
  engine.tick(f.io,f.table,f.table.hand.deadline-1);advance(f);
  assert.equal(f.table.hand.state,STATE.DEALER);finish(f);
  assert.equal(f.table.hand.results[0].insuranceProfit,100);
  assert.equal(f.table.hand.results[0].gameScore,-100);
  assert.equal(f.table.hand.results[0].score,0);
  assert.equal(f.table.members[0].point,5000);
  const g=fixture();g.table.members[0].point=100;toPlayer(g);
  assert.ok(!engine.snapshot(g.table,1).selfAvailableActions.includes('DOUBLE'));
  assert.ok(!engine.act(g.io,g.table,1,SEND.DOUBLE,{},g.table.hand.deadline-1));finish(g);
  assert.ok(g.table.members[0].point>=0);
});
test('hole card stays masked in broadcasts/recovery/actions/fair code until dealer turn', () => {
  const f=fixture([0,12,4,5]);advance(f);advance(f);
  for(const m of f.messages.filter(m=>[PUSH.STATE,PUSH.ACTION].includes(m.id))) {
    if(m.data.dealerCards.length)assert.equal(m.data.dealerCards[1],-1);
    assert.ok(!m.data.actionList.some(a=>a.banker));
  }
  const s=engine.snapshot(f.table,99);assert.equal(s.dealerCards[1],-1);
  const fair=fairCodeDetail(f.table,99,1);assert.ok(fair.pokerList.every(c=>!c.secretKey));
  finish(f);
  const detail=fairCodeDetail(f.table,99,1);
  assert.equal(detail.pokerList.filter(c=>c.secretKey).length,f.table.hand.cursor);
  assert.ok(detail.pokerList.slice(f.table.hand.cursor).every(c=>!c.secretKey));
});
test('settlement animation, replay pages, stats, hot reload and shared pending departure retain liabilities', () => {
  const f=fixture();toPlayer(f);
  const oldHand=f.table.hand, reloaded=new BlackjackGame();
  assert.equal(reloaded.holdSeatUntilRoundEnd(f.table,f.table.members[0]),true);
  assert.equal(reloaded.onLeave({table:f.table,session:{userId:1,wallet:20},io:f.io}),0);
  assert.equal(f.table.members.length,1);assert.equal(f.table.hand,oldHand);
  finish(f);const score=f.table.hand.results[0].score;
  const points=f.table.members[0].point;
  assert.equal(engine.settle(f.io,f.table),false);assert.equal(f.table.members[0].point,points);
  assert.equal(ranking(f.table).userList.find(p=>p.uid===1).winLostScore,score);
  assert.ok(!ranking(f.table).userList.some(p=>p.uid===99));
  const history=engine.historyPayload(f.table,{},99);
  assert.equal(history.gameBackInfo.inningInfo[0].length,2);
  assert.ok(history.gameBackInfo.inningInfo[0].every(p=>p.icon&&Array.isArray(p.handResults[0].handCards)));
  assert.equal(engine.historyPayload(f.table,{},999).total,0);
  assert.equal(engine.historyPayload(f.table,{roomId:1},99).total,0);
  assert.equal(engine.historyPayload(f.table,{beginNum:99},99).currentInning,0);
  const end=f.table.hand.deadline;engine.tick(f.io,f.table,end-1);assert.equal(f.table.hand,oldHand);
  engine.tick(f.io,f.table,end);assert.equal(f.table.hand,null);
  delete f.table.members[0].pendingDeparture;
  engine.begin(f.io,f.table,end+4000,[9,6,9,8,...makeShoe()]);finish(f);
  assert.equal(engine.historyPayload(f.table,{beginNum:0},99).currentInning,1);
  assert.equal(engine.historyPayload(f.table,{beginNum:1},99).currentInning,2);
});
test('settlement and next round share a five second interval without another start delay', () => {
  assert.equal(roomRules().settleTime,5000);
  assert.equal(roomRules({settle_time:7500}).settleTime,7500);
  assert.equal(roomRules({settleTime:1000}).settleTime,5000);
  const f=fixture();finish(f);
  const h=f.table.hand,endAt=h.deadline;
  assert.equal(h.rules.settleTime,5000);
  const settlement=f.messages.find(m=>m.id===PUSH.SETTLE).data;
  assert.equal(settlement.stateDeadline,endAt);
  engine.tick(f.io,f.table,endAt-1);assert.equal(f.table.hand,h);
  engine.tick(f.io,f.table,endAt);
  assert.equal(f.table.hand,null);assert.equal(f.table.phase,'starting');
  assert.equal(f.table.startAt,endAt,'no additional three second pause after settlement');
  engine.begin(f.io,f.table,f.table.startAt);
  assert.equal(f.table.hand.state,STATE.BET);assert.equal(f.table.currentInning,2);
  assert.equal(f.messages.filter(m=>m.id===PUSH.SETTLE).length,1);
});

test('shared admission checks allow the next betting round on the cleanup tick', t => {
  const f=fixture();finish(f);const endAt=f.table.hand.deadline;
  t.mock.method(Date,'now',()=>endAt);
  f.game.playTick({table:f.table,io:f.io},endAt);
  assert.equal(f.table.hand.state,STATE.BET);assert.equal(f.table.currentInning,2);
  assert.equal(f.table.admissionCheckedInning,1);
  const states=f.messages.filter(m=>m.id===PUSH.STATE).slice(-2).map(m=>m.data.gameState);
  assert.deepEqual(states,[STATE.END,STATE.BET]);
});

test('cleanup cannot skip pending payouts, room expiry or no-human suspension', t => {
  const cases=[
    f=>{f.table.roundAdmission={inning:1,payouts:[]};f.table.admissionTask=new Promise(()=>{});},
    f=>{f.table.closing=true;},
    f=>{f.table.members.forEach(p=>p.bot=true);f.table.observers=[];f.table.humanPresenceSeen=true;f.table.emptySinceHands=-2;},
  ];
  let now; t.mock.method(Date,'now',()=>now);
  for(const prepare of cases){
    now=1000;const f=fixture();finish(f);now=f.table.hand.deadline;prepare(f);
    f.game.playTick({table:f.table,io:f.io},now);
    assert.equal(f.table.hand,null);assert.equal(f.table.currentInning,1);
  }
});

test('terminal cleanup cannot restore collected cards or replay settled hands before the next deal', () => {
  const f=fixture();toPlayer(f);let now=f.table.hand.deadline-1;
  engine.act(f.io,f.table,1,SEND.SPLIT,{},now++);
  engine.act(f.io,f.table,1,SEND.DOUBLE,{},now++);
  engine.act(f.io,f.table,1,SEND.STAND,{},now++);finish(f);
  const settled=f.messages.find(m=>m.id===PUSH.SETTLE).data;
  assert.equal(settled.settleList[0].handResults.length,2);
  const points=f.table.members[0].point,house=f.table.houseNetScore;
  const history=structuredClone(engine.historyPayload(f.table,{},99));
  const endAt=f.table.hand.deadline;let terminalRecovery;
  const broadcast=f.io.broadcast;
  f.io.broadcast=(id,data)=>{
    if(id===PUSH.STATE&&data.gameState===STATE.END)terminalRecovery=engine.snapshot(f.table,99,endAt);
    broadcast(id,data);
  };
  engine.tick(f.io,f.table,endAt);
  const cleanup=f.messages.findLast(m=>m.id===PUSH.STATE).data;
  assert.equal(cleanup.gameState,STATE.END);
  for(const snapshot of [cleanup,terminalRecovery]){
    assert.deepEqual(snapshot.players,[],'end state must not reconstruct old player hands');
    assert.deepEqual(snapshot.dealerCards,[],'end state must not reconstruct dealer cards');
    assert.deepEqual(snapshot.actionList,[]);
    assert.equal(snapshot.dealerPointValue,0);
    assert.equal(snapshot.stateDeadline,0);
    assert.ok(!('settleList' in snapshot),'cleanup must not replay the settled result');
  }
  assert.equal(f.table.members[0].point,points);assert.equal(f.table.houseNetScore,house);
  assert.deepEqual(engine.historyPayload(f.table,{},99),history);
  assert.equal(f.table.hand,null);
  engine.begin(f.io,f.table,endAt+4000);
  const next=f.messages.findLast(m=>m.id===PUSH.STATE).data;
  assert.equal(next.gameState,STATE.BET);assert.equal(next.currentInning,cleanup.currentInning+1);
  assert.deepEqual(next.dealerCards,[]);assert.deepEqual(next.actionList,[]);
  assert.ok(next.players.every(p=>p.hands.length===0&&p.betAmount===0));
});

test('robot basic strategy uses own cards and the dealer up-card, with coherent actions', () => {
  assert.equal(choose([7,20],9,['HIT','STAND','DOUBLE','SPLIT']),'SPLIT');
  assert.equal(choose([4,5],8,['HIT','STAND','DOUBLE']),'DOUBLE');
  assert.equal(choose([9,5],5,['HIT','STAND']),'STAND');
  assert.equal(choose([9,5],9,['HIT','STAND']),'HIT');
  assert.equal(choose([0,7],9,['HIT','STAND']),'STAND');
  assert.equal(choose([4,4],0,['HIT','STAND','DOUBLE']),'HIT');
});

test('sustained bot hands consume one real shoe across hot loads, cut between hands and balance against dealer', () => {
  const f=fixture(undefined,3);
  // Keep test players funded for an extended strategy run; no wallet mints
  // or top-ups during the run, and all bots use the same action validator.
  for(const p of f.table.hand.players){p.member.point=p.openingPoint=100000;p.bot=true;}
  const opening=300000;let next=2000, shoes=1, previousShoe=f.table.shoe, lastCursor=0;
  const used=new Set();
  for(let hand=0;hand<120;hand++){
    if(hand){
      engine.tick(f.io,f.table,f.table.hand.deadline);
      assert.equal(f.table.hand,null);
      // Loading a new game object must not alter resident rules, bankrolls,
      // shoe or creation timestamp. Next hand inherits the remaining shoe.
      assert.equal(new BlackjackGame().params(f.table).ante,100);
      engine.begin(f.io,f.table,next);
      if(f.table.shoe!==previousShoe){assert.ok(lastCursor>=262);previousShoe=f.table.shoe;shoes++;lastCursor=0;}
    }
    for(const p of f.table.hand.players)p.bot=true;
    for(let step=0;step<100&&!f.table.hand.settled;step++){
      const h=f.table.hand;
      const at=h.state===STATE.PLAYER?h.players[h.turn].actAt
        :h.state===STATE.BET&&h.players.some(p=>!p.mainBet)||h.state===STATE.INSURANCE&&h.players.some(p=>!p.insuranceOperated)
          ?Math.max(...h.players.map(p=>p.actAt))+1:h.deadline;
      engine.tick(f.io,f.table,at);
    }
    assert.ok(f.table.hand.settled);
    assert.equal(f.table.members.reduce((n,m)=>n+m.point,0)+f.table.houseNetScore,opening);
    assert.ok(f.table.members.every(m=>Number.isSafeInteger(m.point)&&m.point>=0));
    for(const a of f.table.hand.actionList)used.add(a.actionType);
    assert.ok(f.table.shoe.cursor>lastCursor);lastCursor=f.table.shoe.cursor;
    next=f.table.hand.deadline+4000;
  }
  assert.ok(shoes>=2);
  assert.ok(used.has(4)&&used.has(5)&&used.has(12)&&used.has(13),'hit/stand/double/split all exercised');
  assert.equal(f.table.roomFeatures.totalHands,120);
});
test('four native lobby tiers route by full identity and no casino/hundred fallback', () => {
  const rows=seedRooms().filter(r=>r.room_type===31&&r.play_mode===0);assert.equal(rows.length,4);
  const logic=createRoomLogic({num:(v,d)=>v===undefined||v===''?d:Number(v),truthy:v=>!!v});
  for(const r of rows){const p=JSON.parse(r.payload);assert.equal(logic.findRoom(rows,p),r);
    assert.equal(logic.enterRoomPayload(r,{},{}).key,p.key);}
  assert.equal(logic.findRoom(rows,{roomType:31,playMode:0,ante:999}),null);
  assert.equal(logic.findRoom(rows,{roomType:31,playMode:1}),null);
  assert.throws(()=>new BlackjackGame().createTable(1,31,{play_mode:1}),/ordinary blackjack/);
});

test('observer bottom chair uses the real player and all native action/recovery coordinates agree', () => {
  const f=fixture(), session={userId:99};
  const room=projectSeatMessage(f.table,session,2206,f.game.roomInfo(f.table));
  assert.equal(room.memberList[2].userInfo.uid,1);
  const state=projectSeatMessage(f.table,session,4553,engine.snapshot(f.table,99));
  assert.equal(state.players[0].pos,2);
  assert.equal(f.table.members[0].pos,0);
  assert.equal(restoreSeatRequest(f.table,session,5003,{position:0}).position,1);
  const seated={userId:1};projectSeatMessage(f.table,seated,2206,f.game.roomInfo(f.table));
  advance(f);
  const action=f.messages.find(m=>m.id===4554).data;
  const projected=projectSeatMessage(f.table,session,4554,action);
  assert.equal(projected.actionList[0].pos,2);
  assert.equal(projected.actionList[0].displaySeat,2);
});

test('unmodified Bjk consumer restores and settles two separate split hands and insurance metadata', () => {
  const source=fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/Bjk/index.d9872.js',import.meta.url),'utf8');
  const normalized=source.replace(/\['([A-Za-z_$][\w$]*)'\]/g,'.$1').replace(/,([a-zA-Z]\w*\.prototype\.)/g,';\n$1');
  const section=normalized.slice(normalized.indexOf("'BjkViewModel':[function"));
  const method=name=>{
    const line=section.split('\n').find(l=>l.startsWith('Y.prototype.'+name+'='));
    return vm.runInNewContext('('+line.slice(line.indexOf('=')+1).replace(/;$/,'')+')',{
      E:value=>value.slice(),M:{default:{userData:{uid:1}}},
      N:{BjkConfig:{GameState:{SETTLE:8},ReplayActionType:{BET:1,AUTO_BET:2,DEAL:3,INSURANCE_BUY:8,INSURANCE_SKIP:9,AUTO_INSURANCE_SKIP:10},
        getHandCards:r=>r?.handCards||r?.cards||[],getActionHandResult:(a,i)=>a.handResults.find(h=>h.handIndex===i)||a.handResults[0],
        handResultsToHands:rows=>rows.map(r=>({...r,cards:r.handCards,betAmount:r.xiaZhuData}))}},
    });
  };
  const f=fixture();toPlayer(f);let now=f.table.hand.deadline-1;
  engine.act(f.io,f.table,1,SEND.SPLIT,{},now++);engine.act(f.io,f.table,1,SEND.DOUBLE,{},now++);
  engine.act(f.io,f.table,1,SEND.STAND,{},now++);finish(f);
  const consumer={_currentDealCardList:[],_conf:{roomId:f.table.roomId},dealerCards:[],
    getSeatByID:uid=>f.table.members.find(p=>p.uid===uid),shouldApplySettlePhaseState:()=>true,
    syncPlayerList(){},addPlayerToList(){},normalizeCurrentDealJoinSeq(){},
    normalizeHandsFromServer:rows=>rows,isInsuranceCollectedForRound:()=>false,
    getCurrentDealCard(uid){return this._currentDealCardList.find(p=>p.uid===uid);}};
  Object.defineProperty(consumer,'__dealCardList',{get(){return this._currentDealCardList;},set(value){this._currentDealCardList=value;}});
  consumer.applyBj21ActionList=method('applyBj21ActionList');
  method('applyBj21SettleMsg').call(consumer,f.messages.find(m=>m.id===PUSH.SETTLE).data);
  const result=consumer._currentDealCardList[0];assert.equal(result.hands.length,2);
  assert.equal(result.hands[0].cards.length,3);assert.equal(result.hands[1].cards.length,2);
  assert.equal(result.hands[0].betAmount,200);assert.equal(result.hands[1].betAmount,100);
  assert.equal(result.insuranceAmount,0);assert.equal(result.needAction,false);
  assert.equal(result.handPoint,evaluate(result.hands[0].cards,true).pointValue);
});
