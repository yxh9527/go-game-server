import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {createApp} from '../../match/src/create-app.js';
import {createMemoryStore} from '../../cache/rpc/store.js';
import {createMatchStore,attachMatchMetadata} from '../../hall/src/store.js';

test('blind administration validates plans, guards references and broadcasts deletion',async t=>{
  const events=[],runtime={env:'dev',hotVersion:'blind-admin',store:createMemoryStore(),config:{tournament_scheduler:false,admin_token:'platform',admin_agents:[{agent_id:12,token:'agent'}]},log:{error(){}},bus:{publish:async(_c,e)=>events.push(JSON.parse(e))}};
  const app=await createApp(runtime),server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));t.after(()=>clearInterval(runtime.tournamentIdempotency.timer));
  const origin='http://127.0.0.1:'+server.address().port;
  async function req(path,method='GET',body,token='platform'){
    const response=await fetch(origin+'/admin/v1'+path,{method,headers:{'Content-Type':'application/json','X-Admin-Token':token},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,...await response.json()};
  }
  const page=await fetch(origin+'/admin');assert.equal(page.status,200);assert.match(page.headers.get('cache-control'),/no-store/);
  const html=await page.text();new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  const levels=[{level:1,min:10,max:20,bet:0,interval:300,type:1},{type:3,interval:60},{level:2,min:20,max:40,interval:0,type:1}];
  const saved=await req('/blinds','POST',{name:'test <template>',data:levels});assert.equal(saved.status,200);const id=saved.data.id;
  assert.equal(typeof saved.data.data,'string');assert.equal(JSON.parse(saved.data.data)[1].type,3);
  for(const data of [[],[{min:10,max:5}], [{min:10,max:20,interval:5,type:2}], 'bad JSON']){
    assert.equal((await req('/blinds','POST',{name:'bad',data})).status,400);
  }
  assert.equal((await req('/blinds','POST',{name:' ',data:levels})).status,400);
  assert.equal((await req('/blinds/'+id,'PUT',{name:'renamed'})).data.name,'renamed');
  const paused=await req('/blinds','POST',{name:'automatic pause',data:[levels[0],{type:2,interval:999},levels.at(-1)]});
  assert.equal(paused.status,200);assert.equal(JSON.parse(paused.data.data)[1].interval,0);
  assert.equal((await req('/blinds','POST',{name:'bad pause',data:[levels[0],{type:2},{type:3,interval:10},levels.at(-1)]})).status,400);
  assert.equal((await req('/blinds/'+id,'DELETE',undefined,'agent')).status,403);
  await runtime.store.insertMatch({agent_id:1,state:0,blinds_id:id});
  assert.equal((await req('/blinds/'+id,'DELETE')).status,409);
  const another=await req('/blinds','POST',{name:'schedule-used',data:levels});
  runtime.tournamentMemory.schedules.set(99,{id:99,payload:JSON.stringify({blinds_id:another.data.id})});
  assert.equal((await req('/blinds/'+another.data.id,'DELETE')).status,409);
  runtime.tournamentMemory.schedules.delete(99);
  const deleted=await req('/blinds/'+another.data.id,'DELETE');assert.equal(deleted.status,200);assert.equal(deleted.data.deleted,true);
  assert.equal((await req('/blinds/'+another.data.id,'DELETE')).status,404);
  assert.equal((await req('/blinds')).data.some(b=>b.id===another.data.id),false);
  assert.ok(events.some(e=>JSON.parse(e.data).row.deleted));
});

test('hall removes deleted blind metadata and preserves it across hot attachment',()=>{
  const store=createMatchStore();store.replaceMetadata({blinds:[{id:44,data:'[]'}]});
  attachMatchMetadata(store);assert.equal(store.getBlinds(44).id,44);
  store.applyEnvelope({event:'match_metadata',data:JSON.stringify({kind:'blinds',row:{id:44,deleted:true}})});
  assert.equal(store.getBlinds(44),undefined);
});
