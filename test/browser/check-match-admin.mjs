// Isolated servers and browser profile; never touches a resident service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import {createApp} from '../../match/src/create-app.js';
import {createMemoryStore} from '../../cache/rpc/store.js';

const runtime={env:'dev',hotVersion:'admin-browser',config:{admin_token:'browser-test',tournament_scheduler:false},store:createMemoryStore(),rpc:{gateway:{getLoginData:async id=>({userId:id,agentId:1})}},log:{error:console.error},bus:{publish:async()=>{}}};
const proxyMode=process.argv.includes('--proxy'),identityChecks=process.argv.includes('--identity-check'),submissionChecks=process.argv.includes('--submission-check'),refreshChecks=process.argv.includes('--refresh-check'),editorChecks=process.argv.includes('--editor-check');
const prefix=proxyMode?'/gogame-match':'';
const app=await createApp(runtime),server=http.createServer((req,res)=>{
  if(prefix){if(!req.url.startsWith(prefix+'/')){res.writeHead(404);res.end();return;}req.url=req.url.slice(prefix.length);}
  app(req,res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'gogame-admin-'));
const browser=spawn(process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1280,960','about:blank',
],{windowsHide:true,stdio:['ignore','ignore','pipe']});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
try{
  let port;
  for(let i=0;i<100;i++){try{port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];break}catch{}await delay(100)}
  assert.ok(port,'Chrome did not start');
  const page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(t=>t.type==='page');
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j)});
  let id=0;const pending=new Map(),errors=[];
  const send=(method,params={})=>new Promise((resolve,reject)=>{
    const n=++id,timer=setTimeout(()=>{pending.delete(n);reject(Error('CDP timeout '+method))},15000);
    pending.set(n,message=>{clearTimeout(timer);message.error?reject(Error(JSON.stringify(message.error))):resolve(message.result)});ws.send(JSON.stringify({id:n,method,params}));
  });
  ws.on('message',raw=>{const m=JSON.parse(raw);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id)}else if(m.method==='Runtime.exceptionThrown')errors.push(m.params);else if(m.method==='Page.javascriptDialogOpening')send('Page.handleJavaScriptDialog',{accept:true}).catch(()=>{})});
  await send('Page.enable');await send('Runtime.enable');await send('Page.navigate',{url:origin+prefix+'/admin'});
  const evaluate=async expression=>{
    const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;
  };
  async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}throw Error('Browser condition failed: '+expression)}
  await until('!!document.getElementById("token")');
  await evaluate(`el('token').value='browser-test';el('agent').value='1';el('refresh').click()`);
  await until(`el('notice').textContent==='已更新'`);
  await evaluate(`el('newMatch').click();true;`);await until(`el('matchEditor').dataset.loading==='false'`);
  await evaluate(`let draft=JSON.parse(el('matchData').value);draft.championship_name='浏览器回归比赛';el('matchData').value=JSON.stringify(draft);el('matchEditor').requestSubmit()`);
  await until(`Array.from(el('matchRows').rows).some(r=>r.textContent.includes('浏览器回归比赛')&&r.textContent.includes('草稿'))`);
  await evaluate(`Array.from(el('matchRows').rows).find(r=>r.textContent.includes('浏览器回归比赛')).querySelectorAll('button')[1].click()`);
  await until(`Array.from(el('matchRows').rows).some(r=>r.textContent.includes('浏览器回归比赛')&&r.textContent.includes('报名中'))`);
  await send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(new URL('./match-admin-status.png',import.meta.url),Buffer.from(r.data,'base64')));
  await evaluate(`el('blindsTab').click()`);await until(`el('notice').textContent==='已更新'`);
  await evaluate(`el('newBlind').click();el('blindName').value='浏览器盲注 <img src=x onerror=alert(1)>';el('blindEditor').requestSubmit()`);
  await until(`el('blindRows').textContent.includes('浏览器盲注')`);
  assert.equal(await evaluate(`el('blindRows').querySelectorAll('img').length`),0,'untrusted template name became HTML');
  await send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(new URL('./match-admin-blinds.png',import.meta.url),Buffer.from(r.data,'base64')));
  await evaluate(`Array.from(el('blindRows').rows).find(r=>r.textContent.includes('浏览器盲注')).querySelectorAll('button')[1].click()`);
  await until(`!el('blindRows').textContent.includes('浏览器盲注')`);
  await evaluate(`el('operationsTab').click()`);await until(`el('notice').textContent==='已更新'`);
  await evaluate(`el('newOperation').click()`);await until(`el('scheduleMatchFields').querySelectorAll('input').length>0`);
  await evaluate(`document.querySelector('#scheduleMatchFields [data-field="championship_name"]').value='浏览器日常赛';el('operationEditor').requestSubmit()`);
  await until(`el('operationRows').textContent.includes('daily')`);
  assert.equal((await app.locals.tournaments.listSchedules()).at(-1).agent_id,1);
  await evaluate(`el('operationRows').querySelectorAll('button')[1].click()`);await until(`el('operationRows').textContent.includes('停用')`);
  await evaluate(`el('operationKind').value='tickets';el('operationKind').dispatchEvent(new Event('change'))`);await until(`el('notice').textContent==='已更新'`);
  await evaluate(`el('newOperation').click();document.querySelector('#operationFields [data-field="name"]').value='浏览器运营门票';document.querySelector('#operationFields [data-field="num"]').value='10';el('operationEditor').requestSubmit()`);
  await until(`el('operationRows').textContent.includes('浏览器运营门票')`);
  await evaluate(`Array.from(el('operationRows').rows).find(r=>r.textContent.includes('浏览器运营门票')).querySelectorAll('button')[1].click();document.querySelector('#operationFields [data-field="userId"]').value='10001';el('operationEditor').requestSubmit()`);
  await until(`el('notice').textContent==='门票已发放'`);
  assert.equal((await runtime.store.listTickets()).find(t=>t.name==='浏览器运营门票').remain,9);
  await evaluate(`el('matchesTab').click()`);await until(`el('notice').textContent==='已更新'`);
  const row=await runtime.store.insertMatch({agent_id:1,championship_name:'浏览器延迟报名赛',state:2,start_time:Date.now()-1000,delay_register_level:3,delay_register_time:300});
  runtime.tournamentMemory.docs.set(row.id,{registrations:{},outbox:[],clock:{currentBlindLv:1,nextBlindAt:Date.now()+60000}});
  await evaluate(`el('refresh').click()`);await until(`el('matchRows').textContent.includes('延迟报名中')`);
  assert.ok(await evaluate(`el('matchRows').textContent.includes('截止第 3 级')`));
  await send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(new URL('./match-admin-late-signup.png',import.meta.url),Buffer.from(r.data,'base64')));
  const saved=runtime.tournamentMemory.docs.get(row.id);
  Object.assign(saved.clock,{autoPauseIndex:1,pauseRequested:true,pauseAt:Date.now(),pauseVersion:1});
  await evaluate(`el('refresh').click()`);await until(`el('matchRows').textContent.includes('自动暂停点（待管理员恢复）')`);
  assert.ok(await evaluate(`Array.from(el('matchRows').querySelectorAll('button')).some(b=>b.textContent==='恢复比赛')`));
  await send('Page.captureScreenshot',{format:'png'}).then(r=>fs.writeFileSync(new URL('./match-admin-automatic-pause.png',import.meta.url),Buffer.from(r.data,'base64')));
  if(editorChecks){
    await evaluate(`window.editorFetch=fetch;window.editorFirst={id:1001,championship_name:'旧比赛 A',init_point:10000,min_player:2,small_blind:5,big_blind:10,currency:'CNY',state:0};window.editorSecond={...editorFirst,id:1002,championship_name:'新比赛 B'};openMatch(editorFirst);true;`);
    await until(`el('matchFields').querySelector('[data-field="championship_name"]')?.value==='旧比赛 A'`);
    await evaluate(`document.querySelector('#matchFields [data-field="championship_name"]').value='不应写到 B 的旧值';window.editorWrites=0;window.fetch=(url,options)=>{
      if(options.method!=='GET'){editorWrites++;return Promise.resolve({ok:true,json:async()=>({code:0,data:{}})})}
      if(String(url).endsWith('/tickets')&&!window.releaseEditorMetadata)return new Promise(resolve=>{window.releaseEditorMetadata=()=>resolve({ok:true,json:async()=>({code:0,data:[]})})});return editorFetch(url,options)};
      window.secondEditorLoad=run(()=>openMatch(editorSecond));true;`);
    await until(`typeof releaseEditorMetadata==='function'`);
    assert.equal(await evaluate(`el('matchFields').childElementCount===0&&el('matchEditor').querySelector('button[type="submit"]').disabled`),true,'old fields or enabled submit remain while opening a different match');
    await evaluate(`el('matchEditor').requestSubmit();true;`);await delay(50);
    assert.equal(await evaluate(`editorWrites`),0,'an unfinished match editor sent a mutation');
    await evaluate(`releaseEditorMetadata();secondEditorLoad;`);
    assert.equal(await evaluate(`document.querySelector('#matchFields [data-field="championship_name"]').value==='新比赛 B'&&!el('matchEditor').querySelector('button[type="submit"]').disabled`),true);
    await evaluate(`window.fetch=editorFetch;el('closeMatch').click();el('operationsTab').click();true;`);await until(`el('notice').textContent==='已更新'`);
    await evaluate(`el('operationKind').value='schedules';window.fetch=(url,options)=>{
      if(options.method!=='GET'){editorWrites++;return Promise.resolve({ok:true,json:async()=>({code:0,data:{}})})}
      if(String(url).endsWith('/tickets')&&!window.releaseScheduleEditor)return new Promise(resolve=>{window.releaseScheduleEditor=()=>resolve({ok:true,json:async()=>({code:0,data:[]})})});return editorFetch(url,options)};
      window.scheduleEditorLoad=run(()=>openOperation({}));true;`);
    await until(`typeof releaseScheduleEditor==='function'`);
    assert.equal(await evaluate(`el('operationData').value===''&&el('operationEditor').querySelector('button[type="submit"]').disabled`),true,'old operation JSON remains actionable while loading a schedule');
    await evaluate(`el('operationEditor').requestSubmit();true;`);await delay(50);assert.equal(await evaluate(`editorWrites`),0);
    await evaluate(`releaseScheduleEditor();scheduleEditorLoad;`);
    assert.equal(await evaluate(`el('scheduleMatchFields').childElementCount>0&&!el('operationEditor').querySelector('button[type="submit"]').disabled`),true);
    await evaluate(`window.fetch=editorFetch;el('closeOperation').click();el('matchesTab').click();true;`);await until(`el('notice').textContent==='已更新'`);
  }
  if(refreshChecks){
    await evaluate(`window.refreshFetch=fetch;window.refreshRows=structuredClone(matches);window.fetch=(url,options)=>{
      if(String(url).endsWith('/matches')&&options.method==='GET'&&!window.releasePreviousView)return new Promise(resolve=>{window.releasePreviousView=()=>resolve({ok:true,json:async()=>({code:0,data:refreshRows})})});
      if(String(url).endsWith('/blinds')&&options.method==='GET')return Promise.resolve({ok:false,json:async()=>({code:503,msg:'盲注测试暂不可用'})});return refreshFetch(url,options)};
      window.oldViewLoad=run(load);true;`);
    await until(`typeof releasePreviousView==='function'`);
    await evaluate(`el('blindsTab').click();true;`);await until(`el('notice').textContent==='盲注测试暂不可用'`);
    await evaluate(`releasePreviousView();oldViewLoad;`);
    assert.equal(await evaluate(`tab==='blinds'&&el('notice').textContent==='盲注测试暂不可用'&&el('notice').dataset.error==='true'`),true,'old match response replaced the current tab error');
    await evaluate(`window.fetch=refreshFetch;el('matchesTab').click();true;`);await until(`el('notice').textContent==='已更新'`);
    await evaluate(`window.foregroundCalls=0;window.fetch=(url,options)=>{
      if(String(url).endsWith('/matches')&&options.method==='GET'){foregroundCalls++;if(!window.releaseForeground)return new Promise(resolve=>{window.releaseForeground=()=>resolve({ok:true,json:async()=>({code:0,data:refreshRows})})});}return refreshFetch(url,options)};
      lastRefresh=0;window.pendingForeground=run(load);true;`);
    await until(`typeof releaseForeground==='function'`);await delay(1200);
    assert.equal(await evaluate(`foregroundCalls`),1,'background poll replaced a pending manual refresh');
    await evaluate(`releaseForeground();pendingForeground;`);assert.equal(await evaluate(`el('notice').textContent`),'已更新');
    await evaluate(`window.fetch=refreshFetch;true;`);
  }
  if(submissionChecks){
    await evaluate(`window.saveFetch=fetch;el('newMatch').click();true;`);await until(`el('matchFields').querySelector('[data-field="championship_name"]')!==null`);
    await evaluate(`document.querySelector('#matchFields [data-field="championship_name"]').value='重复提交保护比赛';window.matchSubmitCalls=0;window.fetch=(url,options)=>{
      if(String(url).endsWith('/matches')&&options.method==='POST'){matchSubmitCalls++;return saveFetch(url,options).then(response=>new Promise(resolve=>{window.releaseMatchSave=()=>resolve(response)}));}return saveFetch(url,options)};
      el('matchEditor').requestSubmit();el('matchEditor').requestSubmit();true;`);
    await until(`typeof releaseMatchSave==='function'`);assert.equal(await evaluate(`matchSubmitCalls`),1,'duplicate form submission created a second request');
    await evaluate(`el('newMatch').click();true;`);await until(`el('matchFields').querySelector('[data-field="championship_name"]')!==null`);
    await evaluate(`document.querySelector('#matchFields [data-field="championship_name"]').value='新编辑会话';releaseMatchSave();true;`);await delay(100);
    assert.equal(await evaluate(`!el('matchEditor').classList.contains('hide')&&document.querySelector('#matchFields [data-field="championship_name"]').value==='新编辑会话'`),true,'old save closed or changed a new match editor');
    assert.equal((await runtime.store.listMatches()).filter(row=>row.championship_name==='重复提交保护比赛').length,1);
    await evaluate(`window.fetch=saveFetch;el('closeMatch').click();el('operationKind').value='tickets';el('operationsTab').click();true;`);await until(`el('notice').textContent==='已更新'`);
    const ticket=(await runtime.store.listTickets()).find(row=>row.name==='浏览器运营门票'),remaining=ticket.remain;
    await evaluate(`openIssue(${JSON.stringify(ticket)});document.querySelector('#operationFields [data-field="userId"]').value='10001';document.querySelector('#operationFields [data-field="count"]').value='2';window.originalIssueId=issueRequest.requestId;window.issueSubmitCalls=0;window.fetch=(url,options)=>{
      if(String(url).endsWith('/issue')&&options.method==='POST'){issueSubmitCalls++;return saveFetch(url,options).then(response=>new Promise(resolve=>{window.releaseIssueSave=()=>resolve(response)}));}return saveFetch(url,options)};
      el('operationEditor').requestSubmit();el('operationEditor').requestSubmit();true;`);
    await until(`typeof releaseIssueSave==='function'`);assert.equal(await evaluate(`issueSubmitCalls`),1,'duplicate issuance request sent');
    await evaluate(`openIssue(${JSON.stringify(ticket)});window.nextIssueId=issueRequest.requestId;document.querySelector('#operationFields [data-field="userId"]').value='10002';releaseIssueSave();true;`);await delay(100);
    assert.equal(await evaluate(`issueRequest?.requestId===nextIssueId&&nextIssueId!==originalIssueId&&!el('operationEditor').classList.contains('hide')&&document.querySelector('#operationFields [data-field="userId"]').value==='10002'`),true,'old issue completion destroyed a new issue request');
    assert.equal((await runtime.store.listTickets()).find(row=>row.id===ticket.id).remain,remaining-2);
    await evaluate(`window.fetch=saveFetch;el('closeOperation').click();el('matchesTab').click();true;`);await until(`el('notice').textContent==='已更新'`);
  }
  if(identityChecks){
    await evaluate(`window.testNativeFetch=fetch;window.oldRows=structuredClone(matches);window.detachedCancel=Array.from(el('matchRows').querySelectorAll('button')).find(button=>button.textContent==='取消比赛');window.testRequests=[];
      window.fetch=(url,options)=>{testRequests.push({url,method:options.method,agent:options.headers['X-Agent-Id']});if(String(url).endsWith('/matches')&&options.method==='GET'&&!window.releaseOldList)return new Promise(resolve=>{window.oldReadSignal=options.signal;window.releaseOldList=()=>resolve({ok:true,json:async()=>({code:0,data:oldRows})})});return testNativeFetch(url,options)};
      window.delayedList=run(load);true;`);
    await until(`typeof releaseOldList==='function'`);
    await evaluate(`el('agent').value='2';el('agent').dispatchEvent(new Event('input'));true;`);
    assert.equal(await evaluate(`oldReadSignal.aborted&&matches.length===0&&el('matchRows').rows.length===0&&el('matchEditor').classList.contains('hide')&&el('financeDetails').textContent===''`),true);
    await evaluate(`el('refresh').click();true;`);await until(`el('notice').textContent==='已更新'`);
    assert.equal(await evaluate(`matches.length===0`),true);
    await evaluate(`releaseOldList();delayedList;`);
    assert.equal(await evaluate(`matches.length===0&&el('matchRows').rows.length===0`),true,'late old identity rows reappeared');
    const callsBefore=await evaluate(`testRequests.length`);
    await evaluate(`detachedCancel.click();true;`);
    assert.equal(await evaluate(`testRequests.length`),callsBefore,'detached old row submitted under the next identity');
    assert.equal(await evaluate(`testRequests.every(request=>request.url.startsWith(${JSON.stringify(prefix+'/admin/v1/')}))`),true,'embedded page escaped its API prefix');
    await evaluate(`window.fetch=testNativeFetch;el('agent').value='1';el('agent').dispatchEvent(new Event('input'));el('refresh').click();true;`);
    await until(`el('notice').textContent==='已更新'`);
    await evaluate(`window.fetch=(url,options)=>{if(String(url).endsWith('/tickets')&&options.method==='GET'&&!window.releaseOldMetadata)return new Promise(resolve=>{window.metadataSignal=options.signal;window.releaseOldMetadata=()=>resolve({ok:true,json:async()=>({code:0,data:[{id:999,name:'old metadata'}]})})});return testNativeFetch(url,options)};el('newMatch').click();true;`);
    await until(`typeof releaseOldMetadata==='function'`);
    await evaluate(`el('token').value='changed-test';el('token').dispatchEvent(new Event('input'));releaseOldMetadata();true;`);
    await delay(100);
    assert.equal(await evaluate(`metadataSignal.aborted&&el('matchEditor').classList.contains('hide')&&el('matchFields').childElementCount===0&&metadata.tickets.length===0&&matchId===0&&issueRequest===null`),true,'old metadata rebuilt a hidden identity editor');
    await evaluate(`window.fetch=testNativeFetch;el('token').value='browser-test';el('token').dispatchEvent(new Event('input'));true;`);
    await evaluate(`window.fetch=(url,options)=>{if(String(url).endsWith('/schedules')&&options.method==='GET'&&!window.releaseSchedule)return new Promise(resolve=>{window.releaseSchedule=()=>resolve({ok:true,json:async()=>({code:0,data:[{id:999,schedule_kind:'stale-schedule',enabled:1,timezone:'Asia/Shanghai',daily_time:'12:00',payload:'{}'}]})})});return testNativeFetch(url,options)};el('operationKind').value='schedules';el('operationsTab').click();true;`);
    await until(`typeof releaseSchedule==='function'`);
    await evaluate(`el('operationKind').value='tickets';el('operationKind').dispatchEvent(new Event('change'));true;`);await until(`el('notice').textContent==='已更新'&&el('operationRows').textContent.includes('浏览器运营门票')`);
    await evaluate(`releaseSchedule();true;`);await delay(100);
    assert.equal(await evaluate(`el('operationKind').value==='tickets'&&el('operationRows').textContent.includes('浏览器运营门票')&&!el('operationRows').textContent.includes('stale-schedule')`),true,'late schedule list replaced the ticket list');
    await evaluate(`window.fetch=testNativeFetch;true;`);
  }
  assert.deepEqual(errors,[]);console.log('PASS: match publication, delayed signup, schedules, ticket issuance, blind deletion and safe rendering.');
  if(identityChecks)console.log('PASS: proxied admin identity changes abort old reads, reject late responses, block detached row actions, clear old editors and isolate operation lists.');
  if(submissionChecks)console.log('PASS: form submit locking avoids duplicate match/issuance requests and late saves preserve newer editors and issuance references.');
  if(refreshChecks)console.log('PASS: late list responses cannot overwrite the current tab state and automatic polling waits for foreground reads.');
  if(editorChecks)console.log('PASS: editor loading clears old fields/JSON, blocks mutations and enables save only for completed current editors.');
}finally{
  ws?.close();browser.kill();clearInterval(runtime.tournamentIdempotency?.timer);
  await new Promise(r=>{server.closeAllConnections();server.close(r)});
  await delay(200);fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
