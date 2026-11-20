import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../../hall/src/create-app.js';
import { createMatchStore, createRoomStore } from '../../hall/src/store.js';
import { createMetaService } from '../../match/src/services/meta.js';
import { createMemoryStore } from '../../cache/rpc/store.js';
import {toClientMatch} from '../../hall/src/to-client.js';

test('native hall rest state uses the cached authoritative clock and clears for finished matches',()=>{
  const until=Date.now()+60000;
  const row={id:99,state:2,tournament_clock:{index:1,currentBlindLv:1,bigBlind:100,restUntil:until,nextBlindAt:until},
    blind_config:[{min:50,max:100,interval:180},{min:0,max:0,type:3,interval:60},{min:100,max:200,interval:0}]};
  const detail=toClientMatch(row);
  assert.equal(detail.rest,true);assert.equal(detail.blindLevel,1);assert.equal(detail.bigBlind,100);
  assert.equal(detail.nextUpBlindTime,Math.floor(until/1000));assert.ok(detail.nextBlindLastTime>=59);
  assert.equal(toClientMatch({...row,state:3}).rest,false);
});

test('native tournament detail serves all three tabs from resident caches without per-request data-center reads', async t => {
  const calls = { awards: 0, blinds: 0 }, matchStore = createMatchStore();
  const gateway = { authenticate: async (_token, userId) => ({ success: true, userId }), getLoginData: async () => ({ agentId: 11 }) };
  matchStore.replaceMatches([{ id: 8, agent_id: 11, state: 1, currency: 'CNY', award_id: 2, blinds_id: 3 }]);
  matchStore.replacePlayers([{ match_id: 8, player_id: 10001, name: 'registered', points: 5000, status: 1 }]);
  const runtime = { env: 'prod', hotVersion: 'detail-tabs', config: {}, log: { error() {} }, gateway, matchStore, roomStore: createRoomStore(), rpc: { gateway, lobby: {
    async listFinanceGames(){return [];},
    async listAwards() { calls.awards++; return [{ id: 2, detail: '[{"rank":1,"items":[{"kind":"money","currency":"CNY","amount":"50000"}]}]' }]; },
    async listBlinds() { calls.blinds++; return [{ id: 3, data: '[{"min":50,"max":100,"interval":180}]' }]; },
  } } };
  const server = http.createServer(await createApp(runtime));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = async () => {
    const query = new URLSearchParams({ op: '36', type: '1', championshipsConfigId: '8', token: 'test', userId: '10001' });
    return (await fetch('http://127.0.0.1:' + server.address().port + '/api/internal/v1/do?' + query)).json();
  };
  for (let i = 0; i < 2; i++) {
    const body = await request(); assert.equal(body.msgCode, 200);
    assert.equal(body.data.MTTRankPrices[0].price, 50000);
    assert.equal(body.data.MTTUserRanks[0].userName, 'registered');
    assert.equal(body.data.MTTUserRanks[0].point, 5000);
    assert.deepEqual(body.data.blindConfig, ['1/50/100']);
    assert.equal(body.data.increaseBindTime, 3);
  }
  assert.deepEqual(calls, { awards: 1, blinds: 1 });
  matchStore.applyEnvelope({ event: 'match_metadata', data: { kind: 'blinds', row: { id: 3, data: '[{"min":100,"max":200,"interval":240}]' } } });
  assert.deepEqual((await request()).data.blindConfig, ['1/100/200']);
  assert.deepEqual(calls, { awards: 1, blinds: 1 });
  matchStore.replacePlayers([]);
  assert.deepEqual((await request()).data.MTTUserRanks, []);
});

test('reward and blind edits publish configured values through the existing match channel', async () => {
  const events = [], store = createMemoryStore();
  const service = await createMetaService({ hotVersion: 'detail-tabs', store, bus: { publish: async (channel, value) => events.push({ channel, envelope: JSON.parse(value) }) } });
  const award = await service.createAward({ name: 'configured', detail: '[{"rank":1,"items":[{"kind":"money","currency":"CNY","amount":"100"}]}]' });
  await service.updateAward(award.id, { name: 'updated' });
  const blinds = await service.createBlinds({ name: 'configured', data: '[{"min":50,"max":100,"interval":180}]' });
  await service.updateBlinds(blinds.id, { name: 'updated' });
  assert.equal(events.length, 4);
  assert.ok(events.every(event => event.channel === 'match' && event.envelope.event === 'match_metadata'));
  assert.deepEqual(events.map(event => JSON.parse(event.envelope.data).kind), ['award', 'award', 'blinds', 'blinds']);
  assert.equal(JSON.parse(events[3].envelope.data).row.name, 'updated');
});

test('ticket rate configuration rejects zero, nondecimal and unsafe currency before persistence',async()=>{
  const store=createMemoryStore(),service=await createMetaService({hotVersion:'ticket-rates',store});
  for(const rate of ['0','-1','NaN','1e2','0.000000001'])await assert.rejects(()=>service.upsertRate({currency:'CNY',rate}),e=>e.status===400);
  await assert.rejects(()=>service.upsertRate({currency:'bad',rate:'100'}),e=>e.status===400);
  const saved=await service.upsertRate({currency:'CNY',rate:'100'});assert.equal(String(saved.rate),'100');
});

test('native ticket query verifies login and delegates only the authoritative player scope',async t=>{
  const calls=[],gateway={authenticate:async(token,id)=>({success:token==='valid',userId:id}),getLoginData:async()=>({agentId:7,currency:{symbol:'CNY'}})};
  const app=await createApp({env:'prod',hotVersion:'ticket-credit-query',config:{},log:{error(){}},gateway,
    matchStore:createMatchStore(),roomStore:createRoomStore(),rpc:{gateway,lobby:{listFinanceGames:async()=>[]},common:{tournamentTickets:async scope=>{calls.push(scope);return [{id:5,num:20,ticketValue:1,ticketRate:'100'}];}}}});
  const server=http.createServer(app);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const request=async token=>(await fetch(`http://127.0.0.1:${server.address().port}/api/internal/v1/do?op=44&userId=42&token=${token}&agentId=999&currency=USD`)).json();
  const valid=await request('valid');assert.equal(valid.msgCode,200);assert.equal(valid.data[0].num,20);assert.equal(valid.data[0].ticketValue,1);
  assert.deepEqual(calls,[{userId:42,agentId:7,currency:'CNY'}]);
  assert.equal((await request('invalid')).msgCode,401);assert.equal(calls.length,1);
});
