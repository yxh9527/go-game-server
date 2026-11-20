import {managementMarkup,managementScript} from './admin-forms.js';
import {createAdminRequests} from './admin-requests.js';
import {createAdminSubmissions} from './admin-submissions.js';
import {createAdminRefresh} from './admin-refresh.js';
export const adminPage = String.raw`<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>比赛管理</title><style>
body{font:15px system-ui,sans-serif;background:#f5f6f8;color:#202737;margin:0}main{max-width:1100px;margin:32px auto;padding:0 20px}h1{font-size:25px}section{background:white;padding:20px;border-radius:12px;margin:18px 0}label{display:inline-block;margin:6px 14px 6px 0}input,select,button,textarea{font:inherit;border:1px solid #cdd3dd;border-radius:5px;padding:8px}button{cursor:pointer;background:#fff;margin:3px}button:hover{background:#edf3ff}button:disabled{opacity:.5}textarea{box-sizing:border-box;width:100%;min-height:200px;font:14px monospace}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{padding:10px;text-align:left;border-bottom:1px solid #e8ebf0}small{color:#647084}#notice{white-space:pre-wrap;min-height:24px}#notice[data-error="true"]{color:#b42318}.scroll{overflow:auto}.hide{display:none}
</style><main><h1>比赛管理</h1>
<section><label>管理凭证 <input id="token" type="password" autocomplete="off"></label><label>代理 ID <input id="agent" type="number" min="1" step="1"></label><small>平台管理员需选择代理。凭证仅在本页使用。</small><p><button id="matchesTab">比赛列表</button><button id="blindsTab">盲注模板</button><button id="operationsTab">排期与模板</button><button id="refresh">刷新</button></p><div id="notice" role="status" aria-live="polite"></div></section>
<section id="matches"><label>比赛状态 <select id="stateFilter"><option value="">全部</option><option value="0">草稿</option><option value="1">报名中</option><option value="late">延迟报名中</option><option value="2">进行中</option><option value="paused">暂停／等待暂停</option><option value="3">已结束</option><option value="4">已取消／作废</option></select></label><label><input type="checkbox" id="showArchived">包含已归档</label><label><input type="checkbox" id="pendingOnly">只看待退款／派奖</label><button id="newMatch">新建比赛</button><div class="scroll"><table><thead><tr><th>ID</th><th>比赛名称</th><th>状态</th><th>延迟报名</th><th>开赛时间</th><th>人数</th><th>资金处理</th><th>操作</th></tr></thead><tbody id="matchRows"></tbody></table></div><p><small>比赛自动开赛与结束。人工暂停等待当前手牌和结算动画完成，暂停期间冻结盲注、延迟报名及复活窗口。终止比赛将作废并全退。</small></p>
<form id="matchEditor" class="hide"><h2 id="matchTitle">比赛配置</h2><div id="matchFields"></div><details><summary>高级配置 JSON</summary><small>金额为最小积分单位，开赛时间为毫秒时间戳。规则在报名后受保护。</small><textarea id="matchData" aria-label="比赛配置 JSON" required></textarea></details><button type="submit">保存</button><button type="button" id="closeMatch">关闭</button></form><div id="financeDetails"></div></section>
<section id="blinds" class="hide"><p><small>平台管理员可管理盲注。已被比赛或排期引用的模板不能删除。</small></p><button id="newBlind">新建模板</button><div class="scroll"><table><thead><tr><th>ID</th><th>名称</th><th>级别数</th><th>操作</th></tr></thead><tbody id="blindRows"></tbody></table></div>
<form id="blindEditor" class="hide"><h2>盲注模板</h2><label>名称 <input id="blindName" required maxlength="128"></label><p><small>min 小盲、max 大盲、bet 底注，均为比赛积分；interval 为秒。type=1 正常级别，type=2 自动暂停点（管理员恢复后进入下一正常级别，interval 自动为 0），type=3 定时休息。须以正常级别开始和结束。</small></p><textarea id="blindData" aria-label="盲注级别 JSON" required></textarea><button type="submit">保存模板</button><button type="button" id="closeBlind">关闭</button></form></section>${managementMarkup}</main>
<script>
'use strict';
const el=id=>document.getElementById(id),states=['草稿','报名中','进行中','已结束','已取消／作废'];
let tab='matches',matches=[],blinds=[],matchId=0,blindId=0,serverOffset=0;
const adminApiBase=location.pathname.replace(/\/+$/,'')+'/v1';
const adminRequests=(${createAdminRequests.toString()})({identity:()=>({token:el('token').value,agent:el('agent').value}),send:(...args)=>fetch(...args),onIdentityChange:resetAdminIdentity});
const adminSubmissions=(${createAdminSubmissions.toString()})();
const adminRefresh=(${createAdminRefresh.toString()})({view:()=>tab==='operations'?tab+':'+el('operationKind').value:tab,scope:()=>adminRequests.sync(),assertScope:scope=>adminRequests.assertScope(scope),stale:()=>adminRequests.stale()});
function resetAdminIdentity(){
 adminRefresh.invalidate();
 matches=[];blinds=[];matchId=0;blindId=0;serverOffset=0;originalMatch={};operations=[];operationId=0;originalOperation={};metadata={tickets:[],blinds:[],awards:[]};issueRequest=null;
 matchEditorVersion++;blindEditorVersion++;operationEditorVersion++;metadataVersion++;lastRefresh=Date.now();
 for(const id of ['matchRows','blindRows','operationRows','operationHead','financeDetails','matchFields','operationFields','scheduleMatchFields'])el(id).replaceChildren();
 for(const id of ['matchEditor','blindEditor','operationEditor'])el(id).classList.add('hide');
 for(const id of ['matchData','blindData','operationData'])el(id).value='';
 notice('管理身份已变更，请刷新后继续。');
}
function notice(message,error=false){el('notice').textContent=message;el('notice').dataset.error=String(error)}
async function api(path,method='GET',body){
 return adminRequests.request(adminApiBase+path,method,body);
}
async function run(work){const scope=adminRequests.sync();try{await work()}catch(error){if(!error.staleAdminRequest&&scope===adminRequests.sync())notice(error.message,true)}}
function updateEditorControls(form){
 const blocked=form.dataset.loading==='true'||form.getAttribute('aria-busy')==='true';
 for(const button of form.querySelectorAll('button[type="submit"]'))button.disabled=blocked;
}
function setEditorLoading(form,loading){form.dataset.loading=String(loading);updateEditorControls(form)}
function submitForm(form,work){
 if(form.dataset.loading==='true'){notice('表单仍在加载，请稍后保存。',true);return false;}
 return adminSubmissions.submit(form,async()=>{
  form.setAttribute('aria-busy','true');updateEditorControls(form);
  try{await run(work)}finally{form.removeAttribute('aria-busy');updateEditorControls(form)}
 });
}
async function editorRequest(check,path,method,body){try{return await api(path,method,body)}finally{check()}}
async function viewRequest(ticket,path){try{return await api(path)}finally{adminRefresh.assertCurrent(ticket)}}
function button(label,work){const scope=adminRequests.sync(),b=document.createElement('button');b.textContent=label;b.type='button';b.onclick=()=>{if(scope!==adminRequests.sync()){notice('管理身份已变更，请刷新后重试。',true);return;}b.disabled=true;run(work).finally(()=>b.disabled=false)};return b}
function cell(row,text){const td=document.createElement('td');td.textContent=text==null?'':String(text);row.append(td);return td}
function matchView(m){
 const a=m.admin||{},at=Date.now()+serverOffset,c=m.tournament_clock||{},paused=c.pauseRequested||a.pause?.paused;
 const late=a.lateOpen&&!paused&&(!a.lateDeadline||at<a.lateDeadline)&&(!c.nextBlindAt||at<c.nextBlindAt);
 const state=paused?(c.pauseAt!=null?c.autoPauseIndex!=null?'自动暂停点（待管理员恢复）':'已暂停':'等待本局结束后暂停'):late?'延迟报名中':states[Number(m.state)]||'未知状态';
 let window=a.lateLevel>0?'截止第 '+a.lateLevel+' 级':'';
 if(a.lateDeadline){const remaining=Math.max(0,Math.ceil((a.lateDeadline-(c.pauseAt??at))/1000));window+=(window?'；':'')+'剩余 '+Math.floor(remaining/60)+'分'+remaining%60+'秒';}
 if(!window)window='未开启';else if(Number(m.state)===2&&!late&&!paused)window='已截止（'+window+'）';
 return {state,late,paused,window};
}
function renderMatches(){
 el('matchRows').replaceChildren();for(const m of matches){
  const view=matchView(m),filter=el('stateFilter').value,a=m.admin||{};
  if(a.archived&&!el('showArchived').checked||el('pendingOnly').checked&&!(a.refundsPending||a.prizesPending||a.paymentsPending))continue;
  if(filter==='late'?!view.late:filter==='paused'?!view.paused:filter!==''&&Number(m.state)!==Number(filter))continue;
  const tr=document.createElement('tr');cell(tr,m.id);cell(tr,m.championship_name+(a.archived?'（已归档）':''));cell(tr,view.state);cell(tr,view.window);cell(tr,m.start_time?new Date(Number(m.start_time)).toLocaleString():'未设置');cell(tr,(m.current_player||0)+' / '+(m.max_player||'不限'));cell(tr,'待退款 '+(a.refundsPending||0)+'；待派奖 '+(a.prizesPending||0));
  const actions=cell(tr,'');actions.append(button('查看 / 编辑',async()=>openMatch(m)));
  if(Number(m.state)===0)actions.append(button('开放报名',async()=>{await api('/matches/'+m.id+'/state','PUT',{state:1});await load()}));
  if([0,1].includes(Number(m.state)))actions.append(button('取消比赛',async()=>{if(!confirm('确认取消比赛并全额退款？'))return;await api('/matches/'+m.id+'/state','PUT',{state:4});await load()}));
  if(Number(m.state)===2)actions.append(button('终止并全退',async()=>{const reason=prompt('请输入终止原因（1 至 300 字）');if(!reason)return;await api('/matches/'+m.id+'/terminate','POST',{reason});await load()}));
  if(Number(m.state)===2)actions.append(button(view.paused?'恢复比赛':'暂停比赛',async()=>{await api('/matches/'+m.id+'/pause','PUT',{paused:!view.paused});await load()}));
  if(Number(m.state)===0)actions.append(button('删除草稿',async()=>{if(!confirm('仅无报名、无资金记录的草稿可以删除，确认继续？'))return;await api('/matches/'+m.id,'DELETE');await load()}));
  if([3,4].includes(Number(m.state))&&!a.archived)actions.append(button('归档',async()=>{await api('/matches/'+m.id+'/archive','POST',{});await load()}));
  actions.append(button('资金进度',async()=>showFinance(m)),button('运行详情',async()=>{const info=await api('/matches/'+m.id+'/runtime');notice(JSON.stringify(info,null,2))}));el('matchRows').append(tr);
 }
}
function renderBlinds(){
 el('blindRows').replaceChildren();for(const b of blinds){const tr=document.createElement('tr');cell(tr,b.id);cell(tr,b.name);let data=[];try{data=typeof b.data==='string'?JSON.parse(b.data):b.data}catch{}cell(tr,Array.isArray(data)?data.length:'配置有误');const actions=cell(tr,'');
 actions.append(button('编辑',async()=>{blindEditorVersion++;blindId=b.id;el('blindName').value=b.name;el('blindData').value=JSON.stringify(data,null,2);el('blindEditor').classList.remove('hide')}),button('删除',async()=>{if(!confirm('确认删除盲注模板？已被引用的模板不能删除。'))return;await api('/blinds/'+b.id,'DELETE');await load()}));el('blindRows').append(tr)}
}
async function load(){
 if(tab==='operations')return loadOperations();
 const ticket=adminRefresh.foreground();notice('正在读取…');
 try{
  if(tab==='matches'){const rows=await viewRequest(ticket,'/matches');matches=rows;if(matches[0]?.admin?.serverNow)serverOffset=matches[0].admin.serverNow-Date.now();renderMatches()}
  else{blinds=await viewRequest(ticket,'/blinds');renderBlinds()}
  notice('已更新');
 }finally{adminRefresh.finish(ticket)}
}
function switchTab(next){tab=next;adminRefresh.invalidate();el('matches').classList.toggle('hide',next!=='matches');el('blinds').classList.toggle('hide',next!=='blinds');el('operations').classList.toggle('hide',next!=='operations');run(load)}
el('matchesTab').onclick=()=>switchTab('matches');el('blindsTab').onclick=()=>switchTab('blinds');el('refresh').onclick=()=>run(load);el('stateFilter').onchange=renderMatches;
el('newBlind').onclick=()=>{blindEditorVersion++;blindId=0;el('blindName').value='';el('blindData').value=JSON.stringify([{level:1,min:10,max:20,bet:0,interval:300,type:1},{level:2,min:20,max:40,bet:0,interval:0,type:1}],null,2);el('blindEditor').classList.remove('hide')};
el('blindEditor').onsubmit=e=>{e.preventDefault();submitForm(el('blindEditor'),async()=>{
 const scope=adminRequests.sync(),version=blindEditorVersion,id=blindId,data={name:el('blindName').value,data:JSON.parse(el('blindData').value)};
 const check=()=>{adminRequests.assertScope(scope);if(version!==blindEditorVersion)throw adminRequests.stale()};
 await editorRequest(check,'/blinds'+(id?'/'+id:''),id?'PUT':'POST',data);el('blindEditor').classList.add('hide');await load();
})};
el('newMatch').onclick=()=>run(()=>openMatch({championship_name:'',state:0,start_time:Date.now()+serverOffset+3600000,init_point:10000,min_player:2,max_player:100,register_gold:0,service_gold:0,small_blind:10,big_blind:20}));
el('matchEditor').onsubmit=e=>{e.preventDefault();submitForm(el('matchEditor'),async()=>{
 const scope=adminRequests.sync(),version=matchEditorVersion,id=matchId,data=readMatchFields();
 const check=()=>{adminRequests.assertScope(scope);if(version!==matchEditorVersion)throw adminRequests.stale()};
 await editorRequest(check,'/matches'+(id?'/'+id:''),id?'PUT':'POST',data);el('matchEditor').classList.add('hide');await load();
})};
el('closeBlind').onclick=()=>{blindEditorVersion++;el('blindEditor').classList.add('hide')};el('closeMatch').onclick=()=>{matchEditorVersion++;el('matchEditor').classList.add('hide')};
notice('输入管理凭证和代理 ID 后点击刷新。');
${managementScript}
for(const id of ['token','agent'])for(const event of ['input','change'])el(id).addEventListener(event,()=>adminRequests.sync());
addEventListener('pagehide',()=>adminRequests.dispose(),{once:true});
</script></html>`;
