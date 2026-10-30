import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createApp} from '../../match/src/create-app.js';
import {createMemoryStore} from '../../cache/rpc/store.js';

test('backoffice publishes agent-owned matches and schedules; foreign reads and mutations are denied',async t=>{
  let now=Date.parse('2026-10-30T03:00:00Z');
  const events=[],runtime={env:'dev',hotVersion:'scope-test',clock:()=>now,store:createMemoryStore(),config:{tournament_scheduler:false,
    admin_token:'platform-test',admin_agents:[{agent_id:11,token:'agent-eleven'},{agent_id:22,token:'agent-twentytwo'}]},
    log:{error(){}},bus:{publish:async(_channel,e)=>events.push(JSON.parse(e))}};
  const app=await createApp(runtime),server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  t.after(()=>clearInterval(runtime.tournamentIdempotency.timer));
  async function request(path,{token='agent-eleven',method='GET',body,headers={}}={}){
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/admin/v1'+path,{method,
      headers:{'Content-Type':'application/json','X-Admin-Token':token,...headers},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,...await response.json()};
  }
  const spec={init_point:10000,min_player:2,state:1,start_time:now+60000,register_gold:0,small_blind:5,big_blind:10};
  const a=await request('/matches',{method:'POST',body:spec});assert.equal(a.code,0);assert.equal(a.data.agent_id,11);
  const b=await request('/matches',{token:'agent-twentytwo',method:'POST',body:spec});assert.equal(b.data.agent_id,22);
  const list=await request('/matches');assert.deepEqual(list.data.map(row=>row.id),[a.data.id]);
  assert.equal((await request('/matches?agent_id=22')).status,403);
  assert.equal((await request('/matches',{headers:{'X-Agent-Id':'22'}})).status,403);
  assert.equal((await request('/matches',{method:'POST',body:{...spec,agent_id:22}})).status,403);
  for(const [method,path,body] of [['GET','/'+b.data.id],['GET','/'+b.data.id+'/runtime'],['PUT','/'+b.data.id,{championship_name:'bad'}],['PUT','/'+b.data.id+'/state',{state:4}]]){
    assert.equal((await request('/matches'+path,{method,body})).status,404);
  }
  assert.equal((await request('/matches/'+a.data.id,{method:'PUT',body:{agent_id:22}})).status,403);
  assert.equal((await request('/matches/'+a.data.id+'/runtime')).data.row.agent_id,11);
  assert.equal((await request('/matches/'+a.data.id,{method:'PUT',body:{championship_name:'updated'}})).data.championship_name,'updated');
  const template={...spec};delete template.state;delete template.start_time;
  const daily={schedule_kind:'daily',daily_time:'12:00',match:template};
  const sa=await request('/schedules',{method:'POST',body:daily});assert.equal(sa.data.agent_id,11);
  const sb=await request('/schedules',{token:'agent-twentytwo',method:'POST',body:daily});assert.equal(sb.data.agent_id,22);
  assert.deepEqual((await request('/schedules')).data.map(row=>row.id),[sa.data.id]);
  assert.equal((await request('/schedules/'+sb.data.id,{method:'PUT',body:daily})).status,404);
  assert.equal((await request('/schedules',{method:'POST',body:{...daily,match:{...template,agent_id:22}}})).status,403);
  assert.equal((await request('/schedules/'+sa.data.id,{method:'PUT',body:{...daily,daily_time:'13:00'}})).data.daily_time,'13:00');
  await app.locals.tournaments.tick();
  const snapshots=await app.locals.tournaments.snapshot({agentId:11,userId:10001});
  assert.ok(snapshots.length>=2);assert.ok(snapshots.every(s=>s.match.agent_id===11));
  assert.ok(events.length>0);
  assert.equal((await request('/matches',{token:'platform-test'})).status,400);
  assert.ok((await request('/matches?agent_id=22',{token:'platform-test'})).data.every(row=>row.agent_id===22));
  assert.equal((await request('/matches',{token:'bad'})).status,403);
  assert.equal((await request('/blinds',{token:'agent-eleven'})).status,403);
  await assert.rejects(()=>app.locals.tournaments.update(a.data.id,{agent_id:22}),/所属代理/);
  await assert.rejects(()=>app.locals.tournaments.saveSchedule(sa.data.id,{...daily,agent_id:22}),/所属代理/);
});

test('production admin routes fail closed without configured credentials',async t=>{
  const runtime={env:'prod',hotVersion:'scope-prod',config:{tournament_scheduler:false},store:createMemoryStore(),log:{error(){}},bus:{publish:async()=>{}}};
  const app=await createApp(runtime),server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const response=await fetch('http://127.0.0.1:'+server.address().port+'/admin/v1/matches?agent_id=11');
  assert.equal(response.status,403);
});
