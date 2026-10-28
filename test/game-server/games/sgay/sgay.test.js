import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { SgayGame } from '../../../../game-server/src/games/sgay/SgayGame.js';
import { evaluate, compareHands, cardTypeInfo } from '../../../../game-server/src/games/sgay/hand.js';
import { payouts } from '../../../../game-server/src/games/sgay/scoring.js';
import * as engine from '../../../../game-server/src/games/sgay/engine.js';
import * as robot from '../../../../game-server/src/games/sgay/robot.js';
import { fairCodeDetail } from '../../../../game-server/src/core/fair-code.js';
import { ranking } from '../../../../game-server/src/core/room-features.js';
import { projectSeatMessage, restoreSeatRequest } from '../../../../game-server/src/core/seat-view.js';
import { createHandler } from '../../../../game-server/src/create-handler.js';
import { createRegistry, findConfig } from '../../../../game-server/src/registry.js';
import { encodeFrame, decodeFrame } from '../../../../game-server/src/codec.js';
import { seedRooms } from '../../../../cache/rpc/seed.js';
import { createRoomLogic } from '../../../../hall/src/rooms.js';
import * as decode from '../../../../hall/src/decode.js';

function fixture(deck) {
  const game = new SgayGame(), row = seedRooms().find(r => r.game_room_config_id === 3201);
  const table = game.createTable(32010000, 32, row);
  table.members = [1,2,3].map((uid, i) => ({uid, pos:i + 2, name:'p'+uid, point:5000, state:2}));
  table.observers = [{uid:99,name:'watch'}];
  const sessions = [1,2,3,99].map(userId => ({userId, ws:userId, wallet:20000}));
  const messages=[], emit=(uid,id,data)=>messages.push({uid,id,data:structuredClone(data)});
  const io={env:'dev',broadcast:(id,data)=>emit(0,id,data),send:emit,sendUser:emit,
    forEachPlayer:fn=>sessions.forEach(fn),sessionFor:uid=>sessions.find(s=>s.userId===uid)};
  engine.begin(io,table,1000,deck);
  return {game,table,sessions,messages,io};
}
function finish(f) {
  engine.tick(f.io,f.table,f.table.hand.deadline);
  engine.tick(f.io,f.table,f.table.hand.deadline);
  const settledAt=f.table.hand.deadline;
  engine.tick(f.io,f.table,settledAt);
  assert.equal(f.table.hand,null);
  return settledAt;
}

test('Sgay original card IDs, 33 client types, point/face/suit priorities and invalid cards', () => {
  for(const [cards,id] of [[[15,42,29],4],[[48,37,38],3],[[24,17,23],18],[[50,20,49],27],
    [[35,13,17],19],[[14,5,1],1],[[47,37,44],17],[[22,43,45],7],[[10,24,38],31],[[0,13,26],32],[[2,15,28],33]])
    assert.equal(evaluate(cards).cardTypeId,id);
  assert.ok(compareHands(evaluate([2,15,28]),evaluate([12,25,38]))>0);
  assert.ok(compareHands(evaluate([12,25,38]),evaluate([10,24,38]))>0);
  assert.ok(compareHands(evaluate([12,25,38]),evaluate([0,13,26]))>0,'A is low in this game');
  assert.ok(compareHands(evaluate([40,33,17]),evaluate([20,1,4]))>0,'same points: maximum rank');
  assert.ok(compareHands(evaluate([20,1,4]),evaluate([7,14,30]))>0,'same ranks: spades/hearts/clubs/diamonds');
  assert.deepEqual(cardTypeInfo([24,17,23]).pokerEnumList,['CLUB_Q','CLUB_5','CLUB_J']);
  for(const cards of [[1,1,2],[-1,2,3],[1,2,52],[1,2],[NaN,2,3]])assert.throws(()=>evaluate(cards));
});
test('captured four-player and three-player settlements match original 5% tax results', () => {
  for(const [cards,bets,expected] of [
    [[[24,17,23],[33,26,1],[15,42,29],[48,37,38]],[1000,500,1000,500],[950,475,-1000,-500]],
    [[[9,37,12],[40,33,17],[20,1,4]],[500,1000,500],[-500,950,-500]],
  ]) {
    const ps=cards.map((hole,pos)=>({uid:pos+1,pos,hole,result:evaluate(hole),openingPoint:15000,bet:bets[pos]}));
    const result=payouts(ps,500,500);
    assert.deepEqual(result.map(p=>p.score),expected);
    assert.equal(result.reduce((n,p)=>n+p.score+p.tax,0),0);
  }
});
test('ranked-pot caps and triple bonuses conserve chips without negative balances', () => {
  for(let n=2;n<=7;n++)for(let k=0;k<40;k++){
    const deck=Array.from({length:52},(_,i)=>i).sort(()=>Math.random()-.5);
    const ps=Array.from({length:n},(_,pos)=>({uid:pos,pos,openingPoint:5000,bet:500*(1+k%10),result:evaluate(deck.slice(pos*3,pos*3+3))}));
    const result=payouts(ps,500,k%2?500:0);
    assert.ok(result.every(p=>Number.isSafeInteger(p.point)&&p.point>=0));
    assert.equal(result.reduce((n,p)=>n+p.point+p.tax,0),n*5000);
  }
  const ps=[[2,15,28],[12,24,36]].map((hole,pos)=>({uid:pos,pos,openingPoint:5000,bet:500,result:evaluate(hole)}));
  assert.deepEqual(payouts(ps,500).map(p=>p.score),[1000,-1000]);
});
test('private two-card deal, hidden third, observer masks, original betting options and validated actions', () => {
  const f=fixture();
  const mine=f.messages.find(m=>m.uid===1&&m.id===4401).data;
  assert.equal(mine.find(p=>p.uid===1).cardList.filter(c=>c>=0).length,2);
  assert.ok(mine.filter(p=>p.uid!==1).every(p=>p.cardList.every(c=>c===-1)));
  assert.ok(f.messages.find(m=>m.uid===99&&m.id===4401).data.every(p=>p.cardList.every(c=>c===-1)));
  engine.tick(f.io,f.table,2200);
  const option=f.messages.find(m=>m.uid===1&&m.id===4400).data[0];
  assert.deepEqual(option,{operation:1,data:{isEnable:true,ante:500,score:500,maxMultiple:10,leftTime:5}});
  assert.deepEqual(f.messages.find(m=>m.uid===99&&m.id===4400).data,[]);
  for(const v of [NaN,Infinity,-1,0,11,1.5,'2',null])assert.equal(engine.bet(f.io,f.table,1,v,2201),false);
  assert.equal(engine.bet(f.io,f.table,99,1,2201),false);
  assert.equal(engine.bet(f.io,f.table,1,1,f.table.hand.deadline),false);
  assert.equal(engine.bet(f.io,f.table,1,2,2201),true);
  assert.equal(engine.bet(f.io,f.table,1,2,2202),false);
  assert.equal(f.table.members[0].point,4000);assert.equal(f.table.hand.pot,1000);
  const reconnectSeat=f.game.roomInfo(f.table).memberList.find(m=>m.uid===1);
  const reconnectState=engine.snapshot(f.table,{userId:1}).memberDeskInfos.find(m=>m.uid===1);
  assert.equal(reconnectSeat.point-reconnectState.xiaZhuData,4000,'native reconnect replays the wager exactly once');
  assert.equal(f.table.members[0].point,4000,'projection does not mutate actual chips');
  assert.ok(fairCodeDetail(f.table,1,1).pokerList.every(c=>!c.secretKey),'fair code cannot expose the hidden third card');
  for(const p of f.table.hand.players.slice(1))engine.bet(f.io,f.table,p.uid,1,2202);
  engine.tick(f.io,f.table,2300);
  const p=f.table.hand.players[0];
  assert.equal(engine.visibleCards(f.table,p,1).filter(c=>c>=0).length,3);
  assert.deepEqual(engine.visibleCards(f.table,p,99),[-1,-1,-1]);
  assert.equal(engine.show(f.io,f.table,1,{card:-1},2301),false);
  assert.equal(engine.show(f.io,f.table,1,{card:p.hole[2],isShow:true},2301),true);
  assert.deepEqual(engine.visibleCards(f.table,p,99),p.hole);
  assert.equal(engine.show(f.io,f.table,1,{},2302),false);
});
test('timeouts finish hands exactly once, publish 4403 before ranking, and keep 5s between hands', () => {
  const f=fixture(),settledAt=finish(f);
  const result=f.messages.find(m=>m.id===4403).data;
  assert.ok(result.every(p=>p.handPais.length===3&&p.cardTypeInfo.handCardList.length===3));
  assert.equal(result.reduce((n,p)=>n+p.score+p.tax,0),0);
  assert.equal(f.table.members.reduce((n,p)=>n+p.point,0)+f.table.taxCollected,15000);
  assert.equal(ranking(f.table).totalHands,1);
  assert.equal(f.table.startAt-settledAt,5000);
  assert.ok(f.messages.findIndex(m=>m.id===4403)<f.messages.findLastIndex(m=>m.id===1244));
  assert.equal(engine.settle(f.io,f.table),false);
  const detail=fairCodeDetail(f.table,99,1);assert.equal(detail.pokerList.filter(p=>p.secretKey).length,9);
  const history=engine.historyPayload(f.table,{beginNum:0,endNum:0},99);
  assert.equal(history.playBackList.length,1);assert.equal(history.playBackList[0].firstGameList.length,3);
  assert.ok(history.playBackList[0].firstGameList.every(p=>p.userIcon&&p.userName&&p.cardTypePokers.length===3));
  assert.equal(engine.historyPayload(f.table,{},100).playBackList.length,0);
  assert.equal(engine.historyPayload(f.table,{roomId:1},99).playBackList.length,0);
});
test('carry-in during a running hand survives reconnect and settlement without becoming profit', () => {
  const f=fixture();engine.tick(f.io,f.table,2200);
  for(const p of f.table.hand.players)engine.bet(f.io,f.table,p.uid,1,2201);
  f.table.members[0].point+=7000;
  const reconnect=f.game.roomInfo(f.table).memberList.find(m=>m.uid===1);
  assert.equal(reconnect.point-500,11500);
  engine.tick(f.io,f.table,2300);engine.tick(f.io,f.table,f.table.hand.deadline);
  const result=f.messages.find(m=>m.id===4403).data;
  assert.equal(f.table.members[0].point,12000+result.find(p=>p.uid===1).score);
  assert.equal(f.table.members.reduce((n,p)=>n+p.point,0)+f.table.taxCollected,22000);
  assert.equal(result.reduce((n,p)=>n+p.score+p.tax,0),0);
});

test('native history model receives latest hand, previous/next and parseable detail with room/viewer/TTL isolation', t => {
  const f=fixture();finish(f);engine.begin(f.io,f.table,100000);
  engine.pushSnapshot(()=>{},f.table,{userId:199});finish(f);
  assert.ok(fairCodeDetail(f.table,199,2));
  const latest=engine.historyPayload(f.table,{beginNum:-1,endNum:-1},99);
  assert.equal(latest.totalNum,2);assert.equal(latest.playBackList.length,1);
  assert.equal(latest.playBackList[0].currentInningNum,2);
  assert.equal(engine.historyPayload(f.table,{beginNum:0,endNum:0},99).playBackList[0].currentInningNum,1);
  assert.equal(engine.historyPayload(f.table,{beginNum:1,endNum:1},99).playBackList[0].currentInningNum,2);
  assert.equal(engine.historyDetail(f.table,1,199),null);
  assert.equal(engine.historyDetail(f.table,2,200),null);
  const detail=engine.historyDetail(f.table,2,199);
  const source=fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/main/index.88f4e.js',import.meta.url),'utf8');
  const start=source.indexOf("'HistoryModelBase':[function");
  const module=source.slice(start,start+12000),marker="['prototype']['onPushRecordDetail']=";
  const a=module.indexOf(marker)+marker.length,b=module.indexOf("['prototype']",a);
  const consumer=vm.runInNewContext('('+module.slice(a,module.lastIndexOf(',',b))+')');
  let displayed;const model={gameRecordDetailMap:{},_currentPlayBack:latest.playBackList[0],
    recordDetailCallBack:(result,rounds)=>displayed={result,rounds}};
  consumer.call(model,detail);assert.equal(model.isDataReceived,true);
  assert.equal(displayed.result.data.length,3);assert.equal(displayed.rounds.length,2);
  assert.ok(displayed.result.data.every(p=>p.handPais.length===3&&p.userIcon&&p.userName));
  assert.ok(displayed.rounds.every(r=>r.list.every(e=>typeof e.nickName==='string'&&Number.isFinite(e.pot))));
  const now=Date.now();t.mock.method(Date,'now',()=>now+8*3600000+1);
  assert.equal(engine.historyPayload(f.table,{},99).playBackList.length,0);
  assert.equal(engine.historyDetail(f.table,2,199),null);
});

test('seven-seat observer projection is coherent across deals, snapshots, show and settlement', () => {
  const f=fixture(),session={userId:99};
  const room=projectSeatMessage(f.table,session,2206,f.game.roomInfo(f.table));
  assert.equal(room.memberList[0].userInfo.uid,1);
  const snap=projectSeatMessage(f.table,session,3260,engine.snapshot(f.table,session));
  assert.equal(snap.memberDeskInfos[0].pos,0);
  for(const id of [4401,4403,4407]){
    const p={uid:1,pos:2},data=projectSeatMessage(f.table,session,id,id===4407?p:[p]);
    assert.equal((Array.isArray(data)?data[0]:data).pos,0);assert.equal(p.pos,2);
  }
  assert.equal(restoreSeatRequest(f.table,session,5003,{position:0}).position,2);
});
test('robot uses known two cards, legal multipliers and varied action delays', () => {
  for(let i=0;i<200;i++){const n=robot.chooseMultiple({cards:[10,24,-1],maxMultiple:3,point:5000,ante:500});assert.ok(n>=1&&n<=3);}
  assert.equal(robot.chooseMultiple({cards:[],maxMultiple:1,point:500,ante:500}),1);
  assert.ok(robot.thinkTime('bet',()=>0)<robot.thinkTime('bet',()=>.99));
});
test('original Sgay action-button consumer accepts server options and calculates real values', () => {
  const source=fs.readFileSync(new URL('../../../../static/client/2.0.1279/assets/Sgay/index.93c81.js',import.meta.url),'utf8');
  const marker="['prototype']['refreshRaiseBtns']=",start=source.indexOf(marker)+marker.length,end=source.indexOf("['prototype']",start);
  const fn=vm.runInNewContext('('+source.slice(start,source.lastIndexOf(',',end))+')',{cc:{app:{gameRoom:{_conf:{}}}}});
  const f=fixture();engine.tick(f.io,f.table,2200);const data=f.messages.find(m=>m.uid===1&&m.id===4400).data[0].data;
  const panel={getBalanceMaxRateByAnte:()=>10,showSelfHead(){},refreshActionPanelLayoutBySelfSeat(){},
    toggleSelfSeat0Visible(){},toggleMulBtnsVisible(){},refreshQuickBtnsState(){},selectRate(){},startBetCountdown(){},hideBtns(){}};
  fn.call(panel,data);assert.equal(panel.enableBet,true);assert.equal(panel.ante,500);assert.equal(panel.maxRate,10);
});
test('all four lobby tiers strictly match ante/carry/category without creating alternate games', () => {
  const rows=seedRooms().filter(r=>r.room_type===32),logic=createRoomLogic(decode);assert.equal(rows.length,4);
  for(const row of rows){const p=JSON.parse(row.payload);assert.equal(logic.findRoom(rows,p),row);
    assert.equal(logic.enterRoomPayload(row,p,{}).key,p.key);
    for(const key of ['ante','carryMin','roomClassification'])assert.equal(logic.findRoom(rows,{...p,[key]:p[key]+1}),null);}
});
test('wire login stays observing, immediate seat reserves 12s, cancel/timeout and delayed exit preserve wallets', async t=>{
  let now=1800000000000;t.mock.method(Date,'now',()=>now);
  const row=seedRooms().find(r=>r.game_room_config_id===3201),registry=createRegistry(),received=[];
  const runtime={env:'dev',hotVersion:'sgay-integration',registry,configs:[row],findConfig,
    gateway:{async getLoginData(){return {agentId:9,userName:'human'};}},
    wallet:{async load(s){s.wallet=50000;},async persist(){},debit(s,n){if(s.wallet<n)return {ok:false};s.wallet-=n;return {ok:true};},credit(s,n){s.wallet+=n;return {ok:true};}},
    log:{info(){},error(){}}};
  const handler=await createHandler(runtime),ws={readyState:1,send:b=>received.push(decodeFrame(b))};
  const send=(id,body)=>handler.onMessage(ws,encodeFrame(id,body));
  await send(1105,{userId:77,roomId:32010000});await send(2102,{roomId:32010000,roomType:32});
  const table=registry.getTable(32010000,9,'sgay'),session=registry.session(ws);
  assert.ok(table);assert.equal(table.members.length,0);assert.equal(table.observers.length,1);
  assert.equal(received.find(m=>m.msgid===2201).payload.conf.roomType,'sgya');
  await send(5003,{position:0});assert.equal(table.members.length,1);assert.equal(table.members[0].point,0);
  const deadline=table.members[0].carryDeadline;now+=5000;await send(5002,{});assert.equal(table.members[0].carryDeadline,deadline);
  now=deadline+1;await send(5001,{carryIn:50});assert.equal(table.members.length,0);assert.equal(session.wallet,50000);
  await send(5003,{position:0});await send(5001,{carryIn:100});assert.equal(session.wallet,40000);
  table.members.push({uid:88,pos:6,name:'peer',point:10000,state:2});
  const game=handler.games.byRoomType.get(32);engine.begin({broadcast(){},env:'dev'},table,now);
  await send(2110);assert.equal(session.wallet,40000);assert.ok(table.members.find(m=>m.uid===77).pendingDeparture);
  const io={broadcast(){},env:'dev'};engine.tick(io,table,table.hand.deadline);engine.tick(io,table,table.hand.deadline);engine.tick(io,table,table.hand.deadline);
  const point=table.members.find(m=>m.uid===77).point;await game.afterRound({table,io,runtime});
  assert.equal(session.wallet,40000+point);assert.ok(!table.members.some(m=>m.uid===77));
  assert.ok(handler.getDevHoldemRecordDetail(table.roomId,1,77,9));
  assert.equal(handler.getDevHoldemRecordDetail(table.roomId,1,78,9),null);
  assert.equal(handler.getDevHoldemRecordDetail(table.roomId,1,77,10),null);
});
