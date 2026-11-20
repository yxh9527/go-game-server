import {importHotModule} from '../../shared/hot-import.js';
import test from 'node:test';
import assert from 'node:assert/strict';
const {tournamentEliminationGroups,tournamentEliminationOrder,validateTournamentFinalRanks}=await importHotModule(new URL('../../shared/tournament-ranking.js',import.meta.url).href,'tournament-regression');

test('elimination grouping is independent of reply ordering and preserves the original settled stacks',()=>{
  const players=[{uid:3,point:0,openingPoint:200},{uid:2,point:0,openingPoint:100},{uid:1,point:0,openingPoint:200}];
  const original=structuredClone(players),groups=tournamentEliminationGroups(players);
  assert.deepEqual(groups.map(g=>[g.openingPoint,g.players.map(p=>p.uid)]),[[100,[2]],[200,[1,3]]]);
  assert.deepEqual(groups,tournamentEliminationGroups(players.slice().reverse()));assert.deepEqual(players,original);
  for(const bad of [[players[0],players[0]],[{uid:1,point:0}],[{uid:1,point:1,openingPoint:100}],[{uid:1,point:0,openingPoint:-1}]])assert.throws(()=>tournamentEliminationGroups(bad));
});

test('equal opening stacks use numeric UID for distinct places without pooling rewards',()=>{
  const players=[{uid:10,point:0,openingPoint:100},{uid:2,point:0,openingPoint:100},{uid:3,point:0,openingPoint:50}];
  assert.deepEqual(tournamentEliminationOrder(players).map(p=>p.uid),[3,2,10]);
  for(const ordered of [players,players.slice().reverse()]){
    const ranks=tournamentEliminationOrder(ordered).map((p,index)=>({uid:p.uid,rank:4-index}));
    ranks.push({uid:99,rank:1});assert.doesNotThrow(()=>validateTournamentFinalRanks(ranks));
    assert.deepEqual(ranks.map(p=>p.rank),[4,3,2,1]);
  }
  for(const ranks of [[{uid:1,rank:1},{uid:2,rank:1}],[{uid:1,rank:1},{uid:2,rank:3}],[{uid:1,rank:1},{uid:1,rank:2}],[]])
    assert.throws(()=>validateTournamentFinalRanks(ranks));
});
