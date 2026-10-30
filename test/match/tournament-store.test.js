import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataCenterStore } from '../../shared/rpc/implementations/prod/dataCenterStore.js';
import { createMatchStore } from '../../hall/src/store.js';
import { tournamentSnapshot } from '../../shared/tournament-snapshot.js';

test('production tournament persistence delegates the entire callback transaction to data-center',async()=>{
  const calls=[],tx={row:{id:9,state:1},state:{registrations:{},outbox:[]}};
  const repo=createDataCenterStore(async()=>({withMatch:async(id,work)=>{calls.push(id);return work(tx);}}));
  const value=await repo.withMatch(9,async({row,state})=>{row.state=4;state.registrations[1]={status:'refund_pending'};return 'saved';});
  assert.equal(value,'saved');assert.deepEqual(calls,[9]);assert.equal(tx.row.state,4);
});

test('tournament snapshots carry the registered blind plan without altering persisted match rows', () => {
  const row = { id: 9, blinds_id: 3 }, frozenBlinds = [{ min: 50, max: 100, interval: 180 }];
  const data = tournamentSnapshot(row, { frozenBlinds, registrations: {}, outbox: [] });
  assert.deepEqual(data.match.blind_config, frozenBlinds);
  assert.equal(row.blind_config, undefined);
});
test('occurrence identity and creation are one data-center operation without Node SQL or split queries',async()=>{
  const calls=[],repo=createDataCenterStore(async()=>({call:async(operation,payload)=>{calls.push({operation,payload});return {id:9};}}));
  const schedule={id:3,agent_id:11},slot={key:'3:today',startTime:1000},row={agent_id:11};
  assert.equal((await repo.ensureOccurrence(schedule,slot,row)).id,9);
  assert.deepEqual(calls,[{operation:'ensureOccurrence',payload:{schedule,slot,row}}]);
});
test('hall discards stale tournament snapshots without restoring withdrawn players',()=>{
  const store=createMatchStore();
  store.applyEnvelope({event:'match_snapshot',data:JSON.stringify({sequence:4,match:{id:9,state:1},players:[],tables:[]})});
  store.applyEnvelope({event:'match_snapshot',data:JSON.stringify({sequence:3,match:{id:9,state:1},players:[{match_id:9,player_id:1}],tables:[]})});
  assert.equal(store.getPlayer(9,1),null);
});
