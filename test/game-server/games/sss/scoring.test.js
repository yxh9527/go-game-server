import test from 'node:test';
import assert from 'node:assert/strict';
import { comparison } from '../../../../game-server/src/games/sss/engine.js';

function player(uid, value, extra = {}) {
  return { uid, openingPoint: 100000, result: { isWater:false,hasSpecialType:false,hasHorseCard:false,
    frontHand:{key:[0,value],water:1},middleHand:{key:[0,value],water:1},backHand:{key:[0,value],water:1},...extra } };
}
const run = players => comparison({ante:10,hand:{players}});
test('ties score zero; ties plus a real win still form a twofold scoop', () => {
  assert.equal(run([player(1,8),player(2,8)]).scoreMap[1],0);
  const a=player(1,8),b=player(2,8);a.result.frontHand.key=[0,9];
  const r=run([a,b]);assert.equal(r.scoreMap[1],20);assert.equal(r.compareResults[1][2].player1Scoop,true);
  assert.deepEqual(r.homeRunPlayerIds,[]);
});
test('a three-player home run is fourfold, and horse doubles either direction', () => {
  const r=run([player(1,10),player(2,9),player(3,8)]);
  assert.deepEqual(r.homeRunPlayerIds,[1]);
  assert.equal(r.compareResults[1][2].player1Score,120);
  assert.equal(r.compareResults[2][3].player1Score,60);
  assert.equal(r.scoreMap[1],240);
  for(const horse of [1,2]){
    const players=[player(1,10),player(2,9)];players.find(p=>p.uid===horse).result.hasHorseCard=true;
    assert.equal(run(players).scoreMap[1],120);
  }
});
test('natural specials use direct per-opponent water and no scoop; equivalent ranks tie', () => {
  const x={hasSpecialType:true,specialType:{typeId:8,water:9,strength:1}};
  const y={hasSpecialType:true,specialType:{typeId:9,water:9,strength:1}};
  assert.equal(run([player(1,1,x),player(2,14)]).scoreMap[1],90);
  assert.equal(run([player(1,1,x),player(2,14,y)]).scoreMap[1],0);
  assert.deepEqual(run([player(1,1,x),player(2,14)]).scoopRelations,[]);
  assert.equal(run([player(1,14,{isWater:true}),player(2,1)]).scoreMap[1],-30);
});
test('all pair scores mirror their opponent and caps conserve integer bankrolls', () => {
  const ps=[player(1,14),player(2,13),player(3,12),player(4,11)];
  for(const p of ps)p.openingPoint=3;
  const r=run(ps);
  assert.equal(Object.values(r.scoreMap).reduce((s,n)=>s+n,0),0);
  for(const p of ps){
    assert.ok(p.openingPoint+r.scoreMap[p.uid]>=0);
    for(const q of ps.filter(q=>q!==p)){
      assert.equal(r.compareResults[p.uid][q.uid].player1Score,-r.compareResults[q.uid][p.uid].player1Score);
      assert.ok(Number.isSafeInteger(r.compareResults[p.uid][q.uid].player1Score));
    }
  }
});
