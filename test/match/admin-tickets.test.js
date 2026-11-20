import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../../match/src/create-app.js';
import {createMemoryStore} from '../../cache/rpc/store.js';

test('operator issuance checks player ownership and inventory, retries once, and retires ticket types without erasing them',async t=>{
 const runtime={env:'dev',hotVersion:'ticket-admin',store:createMemoryStore(),rpc:{gateway:{getLoginData:async userId=>({userId,agentId:userId===42?7:8})}},config:{admin_token:'platform',admin_agents:[{agent_id:7,token:'agent'}],tournament_scheduler:false},log:{error(){}},bus:{publish:async()=>{}}};
 const app=await createApp(runtime),server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r)}));t.after(()=>clearInterval(runtime.tournamentIdempotency.timer));
 async function api(path,method='GET',body,token='platform'){
  const r=await fetch('http://127.0.0.1:'+server.address().port+'/admin/v1'+path,{method,headers:{'Content-Type':'application/json','X-Admin-Token':token,'X-Agent-Id':'7'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,...await r.json()};
 }
 const created=await api('/tickets','POST',{name:'运营门票',num:10,price:1,currency:'CNY'});assert.equal(created.status,200);const id=created.data.id;
 const request={userId:42,count:2,requestId:'ticket:batch-one'};
 assert.equal((await api('/tickets/'+id+'/issue','POST',request,'agent')).status,403);
 assert.equal((await api('/tickets/'+id+'/issue','POST',{...request,userId:43})).status,403);
 assert.equal((await api('/tickets/'+id+'/issue','POST',request)).data.issued,2);
 assert.equal((await api('/tickets/'+id+'/issue','POST',request)).data.replayed,true);
 assert.equal((await runtime.store.listTickets()).find(t=>t.id===id).remain,8);
 assert.equal((await api('/tickets/'+id+'/issue','POST',{...request,count:3})).status,409);
 assert.equal((await api('/tickets/'+id,'PUT',{remain:9})).status,409);
 assert.equal((await api('/tickets/'+id,'PUT',{num:1})).status,409);
 assert.equal((await api('/tickets/'+id,'PUT',{num:12})).data.remain,10);
 assert.equal((await api('/tickets/'+id,'DELETE')).data.disabled,true);
 assert.equal((await api('/tickets/'+id+'/issue','POST',{...request,requestId:'ticket:new'})).status,409);
 assert.equal((await api('/tickets/'+id+'/issue','POST',request)).data.replayed,true);
 assert.ok((await runtime.store.listTickets()).some(t=>t.id===id&&t.disabled));
});
