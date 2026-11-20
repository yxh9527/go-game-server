import test from 'node:test';
import assert from 'node:assert/strict';
import {HoldemGame} from '../../../../game-server/src/games/holdem/HoldemGame.js';
import {beginHand,tickPlaying,onTexasAction,pushPlayingSnapshot,foldIfPlaying,texasConf} from '../../../../game-server/src/games/holdem/engine.js';
import {PUSH} from '../../../../game-server/src/messages.js';
import {OP} from '../../../../game-server/src/games/holdem/op.js';

function fixture(stacks=[100,200,300]){
 const game=new HoldemGame(),table=game.createTable(19270000,19,{room_type:19,play_mode:8,game_room_config_id:1927,small_blind:100,big_blind:200,
   initial_bet:0,aof_bet:100,carry_min:100,force_show_card:1});
 table.members=stacks.map((point,pos)=>({uid:pos+1,name:'player',point,pos,state:1,bot:pos===1}));
 const messages=[],record=(id,payload,uid)=>messages.push({id,payload:structuredClone(payload),uid});
 const io={env:'dev',broadcast:(id,payload)=>record(id,payload),send:(uid,id,payload)=>record(id,payload,uid),sendUser:(uid,id,payload)=>record(id,payload,uid),
   forEachPlayer:fn=>[1,2,3,99].forEach(uid=>fn({userId:uid,ws:uid}))};
 return {game,table,io,messages};
}
test('AOF captured fixed wagers replace blinds and betting controls; cards remain private until the common showdown',()=>{
 const f=fixture();beginHand(f.io,f.table);assert.equal(f.table.playMode,9);assert.equal(texasConf(f.table).dzpk.aofBet,100);
 assert.equal(f.table.hand.pot,300);assert.deepEqual(f.table.members.map(p=>[p.point,p.totalBet]),[[0,100],[100,100],[200,100]]);
 const paid=f.messages.filter(m=>m.id===PUSH.DZPK_ACTION_BET_PUSH);assert.equal(paid.length,3);
 assert.deepEqual(paid.map(m=>m.payload.operation),[OP.ALL_IN,OP.BET,OP.BET]);assert.ok(paid.every(m=>m.payload.currentBetScore===100));
 assert.equal(f.messages.some(m=>m.id===PUSH.DZPK_OPERATION_PUSH),false);assert.equal(f.table.hand.actorUid,0);
 assert.ok(f.messages.find(m=>m.id===PUSH.DZPK_DEAL_DI_PUSH&&m.uid===99).payload.every(p=>p.cardList.every(c=>c===-1)));
 const frozen=f.table.hand,deadline=frozen.aofNextAt;
 for(const operation of [OP.ADD,OP.BET,OP.ALL_IN,OP.FOLLOW,OP.ABANDON,OP.PASS])onTexasAction(f.io,f.table,{userId:1},{operation,operationData:999});
 foldIfPlaying(f.io,f.table,1);assert.equal(f.table.hand,frozen);assert.equal(frozen.pot,300);assert.ok(f.table.members.every(p=>!p.folded));
 tickPlaying(f.io,f.table,deadline-1);assert.equal(frozen.board.length,0);
 for(let step=0;step<3;step++){tickPlaying(f.io,f.table,frozen.aofNextAt);assert.equal(frozen.board.length,[3,4,5][step]);}
 assert.equal(f.messages.some(m=>m.id===PUSH.DZPK_ACTION_SHOWCARD_PUSH),false);
 const privateSnapshot=[];pushPlayingSnapshot((id,payload)=>privateSnapshot.push({id,payload}),f.table,{userId:99});
 assert.ok(privateSnapshot[0].payload.memberDeskInfos.every(p=>p.handPais.every(c=>c===-1)));
 tickPlaying(f.io,f.table,frozen.aofNextAt);assert.equal(f.table.hand,null);
 const results=f.messages.find(m=>m.id===PUSH.DZPK_INNING_RESULT_PUSH).payload;
 assert.ok(results.every(p=>p.xiaZhuData===100));assert.equal(results.reduce((n,p)=>n+p.score,0),0);assert.equal(f.table.members.reduce((n,p)=>n+p.point,0),600);
 const reveals=f.messages.filter(m=>m.id===PUSH.DZPK_ACTION_SHOWCARD_PUSH);assert.equal(reveals.length,3);
 assert.ok(reveals.every(m=>m.payload.holeCardList.length===2&&m.payload.cardTypeInfo));
 assert.equal(f.table.roomFeatures.totalHands,1);tickPlaying(f.io,f.table,deadline+999999);assert.equal(f.table.roomFeatures.totalHands,1);
});

test('underfunded seats do not join a fixed AOF wager and invalid configuration is rejected before a table can fund play',()=>{
 const f=fixture([99,100,200]);assert.equal(f.game.seated(f.table).length,2);assert.equal(f.game.shouldStandAfterRound(f.table,f.table.members[0]),true);
 assert.equal(f.game.defaultBuyIn(f.table),100);beginHand(f.io,f.table);assert.equal(f.table.hand.pot,200);assert.equal(f.table.members[0].point,99);
 for(const patch of [{aof_bet:0},{aof_bet:1.5},{initial_bet:1},{carry_min:99}])assert.throws(()=>f.game.createTable(1,19,{...f.table.cfg,...patch}));
});

test('AOF board, fixed contribution and next transition survive a game object replacement without charging again',()=>{
 const f=fixture();beginHand(f.io,f.table);const hand=f.table.hand,at=hand.aofNextAt;tickPlaying(f.io,f.table,at);
 const replacement=new HoldemGame();replacement.playTick({table:f.table,io:f.io},hand.aofNextAt-1);
 assert.equal(f.table.hand,hand);assert.equal(hand.board.length,3);assert.equal(f.messages.filter(m=>m.id===PUSH.DZPK_ACTION_BET_PUSH).length,3);
 replacement.playTick({table:f.table,io:f.io},hand.aofNextAt);assert.equal(hand.board.length,4);
});
