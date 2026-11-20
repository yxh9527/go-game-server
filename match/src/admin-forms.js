export const managementMarkup=String.raw`
<section id="operations" class="hide"><h2>排期与模板</h2>
<label>管理项目 <select id="operationKind"><option value="schedules">比赛排期</option><option value="tickets">门票种类</option><option value="ticket-rates">门票兑换比例</option><option value="awards">奖励模板</option></select></label><button id="newOperation">新增</button><p id="operationHint"></p><div class="scroll"><table><thead id="operationHead"></thead><tbody id="operationRows"></tbody></table></div>
<form id="operationEditor" class="hide"><h3 id="operationTitle"></h3><div id="operationFields"></div><div id="scheduleMatchFields"></div><details><summary>奖励／排期高级配置</summary><textarea id="operationData" aria-label="模板配置 JSON"></textarea></details><button type="submit">保存</button><button type="button" id="closeOperation">关闭</button></form></section>`;

export const managementScript=String.raw`
const fieldDefs=[
 ['championship_name','比赛名称','text'],['consults','说明','text'],['start_time','开赛时间（本机时区）','date'],
 ['min_player','最低开赛人数','number',2],['max_player','最多人数（0 不限）','number',0],['init_point','初始比赛积分','number',1],
 ['register_gold','报名费（最小积分）','number',0],['service_gold','服务费（最小积分）','number',0],['currency','币种','text'],
 ['register_ticket','必需门票张数','number',0],['ticket_id','门票种类','tickets'],['allow_ticket_pay','允许门票抵扣','check'],
 ['blinds_id','盲注模板','blinds'],['small_blind','未选模板时的小盲','number',1],['big_blind','未选模板时的大盲','number',1],
 ['award_id','奖励模板','awards'],['delay_register_level','延迟报名截止级别（0 不限）','number',0],['delay_register_time','延迟报名秒数（0 不限）','number',0],
 ['rebuy_time','最多复活次数','number',0],['register_time_limit','开赛前报名窗口秒数（0 不限）','number',0],['force_show_card','强制亮牌','check']
];
let originalMatch={},operations=[],operationId=0,originalOperation={},metadata={tickets:[],blinds:[],awards:[]};
let matchEditorVersion=0,blindEditorVersion=0,operationEditorVersion=0,metadataVersion=0,operationListVersion=0;
const localDate=value=>{if(!value)return '';const date=new Date(Number(value));return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)};
function inputField(parent,key,label,type,value,min=0){
 const wrap=document.createElement('label');wrap.append(document.createTextNode(label+' '));
 const input=document.createElement(type==='select'?'select':'input');input.dataset.field=key;
 if(type!=='select')input.type=type==='date'?'datetime-local':type==='check'?'checkbox':type;
 if(type==='number'){input.min=min;input.step='1'}
 if(type==='check')input.checked=Number(value)===1||value===true;
 else input.value=type==='date'?localDate(value):value??'';
 if(type==='date')input.dataset.date='true';
 input.dataset.initial=type==='check'?String(input.checked):input.value;
 wrap.append(input);parent.append(wrap);return input;
}
function buildMatchFields(container,row,forSchedule=false){
 container.replaceChildren();
 for(const [key,label,type,min] of fieldDefs){
  if(forSchedule&&key==='start_time')continue;
  let input;
  if(['tickets','blinds','awards'].includes(type)){
   input=inputField(container,key,label,'select');
   const rows=(metadata[type]||[]).filter(row=>!row.disabled),options=[{id:0,name:'不选择'},...rows];
   if(row[key]&&!options.some(r=>Number(r.id)===Number(row[key])))options.push({id:Number(row[key]),name:'ID '+row[key]});
   for(const option of options){const o=document.createElement('option');o.value=option.id;o.textContent=option.name||String(option.id);input.append(o)}input.value=Number(row[key]||0);input.dataset.initial=input.value;input.dataset.numeric='true';
  }else input=inputField(container,key,label,type,row[key]??(type==='check'?key==='force_show_card'?1:0:key==='currency'?'CNY':''),min);
  input.disabled=Boolean(row.admin?.locked&&!['championship_name','consults'].includes(key));
 }
}
function mergeFields(container,data){
 for(const input of container.querySelectorAll('[data-field]')){
  const value=input.type==='checkbox'?String(input.checked):input.value;
  if(input.disabled||value===input.dataset.initial)continue;
  let converted=input.type==='checkbox'?Number(input.checked):input.type==='number'||input.dataset.numeric?Number(value):input.dataset.date?new Date(value).getTime():value;
  if(typeof converted==='number'&&!Number.isSafeInteger(converted))throw Error('请输入有效的整数或时间');
  if(input.dataset.field==='award_id'&&converted!==Number(data.award_id||0))data.award_json='';
  data[input.dataset.field]=converted;
 }return data;
}
function cleanMatch(data){for(const key of ['id','agent_id','admin','tournament_clock','create_time','update_time','current_player','current_live_player'])delete data[key];return data}
async function fetchMetadata(){
 const scope=adminRequests.sync(),version=++metadataVersion;
 const results=await Promise.allSettled(['tickets','blinds','awards'].map(kind=>api('/'+kind)));
 adminRequests.assertScope(scope);if(version!==metadataVersion)throw adminRequests.stale();
 ['tickets','blinds','awards'].forEach((kind,i)=>metadata[kind]=results[i].status==='fulfilled'?results[i].value:[]);
}
async function openMatch(row){
 const scope=adminRequests.sync(),version=++matchEditorVersion;
 setEditorLoading(el('matchEditor'),true);el('matchFields').replaceChildren();el('matchTitle').textContent='正在加载比赛配置…';
 matchId=Number(row.id||0);originalMatch=structuredClone(row);el('matchData').value=JSON.stringify(row,null,2);el('matchEditor').classList.remove('hide');
 await fetchMetadata();adminRequests.assertScope(scope);if(version!==matchEditorVersion)throw adminRequests.stale();buildMatchFields(el('matchFields'),row);el('matchTitle').textContent=matchId?'编辑比赛 '+matchId:'新建比赛';setEditorLoading(el('matchEditor'),false);
}
function readMatchFields(){
 const data=cleanMatch(mergeFields(el('matchFields'),JSON.parse(el('matchData').value)));
 if(!matchId)return data;
 return Object.fromEntries(Object.entries(data).filter(([key,value])=>JSON.stringify(value)!==JSON.stringify(originalMatch[key])));
}
function showFinance(m){
 const a=m.admin||{},root=el('financeDetails');root.replaceChildren();const title=document.createElement('h3');title.textContent='比赛 '+m.id+' 资金处理';root.append(title);
 const info=document.createElement('p');info.textContent='待扣款 '+(a.paymentsPending||0)+'；待退款 '+(a.refundsPending||0)+'；退款完成 '+(a.refundsCompleted||0)+'；待派奖 '+(a.prizesPending||0)+'；派奖完成 '+(a.prizesPaid||0);root.append(info);
 if(a.cancelReason){const reason=document.createElement('p');reason.textContent='取消／作废原因：'+a.cancelReason;root.append(reason)}
 for(const error of a.errors||[]){const p=document.createElement('p');p.textContent='玩家 '+(error.userId||'未知')+'：'+error.message;root.append(p)}
 if(!(a.errors||[]).length){const p=document.createElement('p');p.textContent='当前没有记录到处理错误。待处理项目由既有调度继续重试。';root.append(p)}
}
async function loadOperations(){
 if(tab!=='operations')return;
 const scope=adminRequests.sync(),version=++operationListVersion;
 const ticket=adminRefresh.foreground();
 notice('正在读取…');
 try{
 const kind=el('operationKind').value,rows=await viewRequest(ticket,'/'+kind);
 adminRequests.assertScope(scope);if(version!==operationListVersion||kind!==el('operationKind').value)throw adminRequests.stale();
 operations=rows;el('operationHead').replaceChildren();const header=document.createElement('tr');
 for(const text of ['ID / 币种','名称 / 配置','状态 / 数量','操作']){const th=document.createElement('th');th.textContent=text;header.append(th)}el('operationHead').append(header);el('operationRows').replaceChildren();
 el('operationHint').textContent=kind==='schedules'?'日常赛按运营时区生成独立场次；停用排期不取消已生成比赛。':kind==='ticket-rates'?'比例 100 表示 100 张票抵 1 个显示货币单位；CNY 下 1 张抵 1 分。':'公共门票和模板配置仅平台管理员可管理。';
 for(const row of operations){const tr=document.createElement('tr');cell(tr,row.id||row.currency);cell(tr,row.name||row.schedule_kind||row.currency);cell(tr,kind==='schedules'?(Number(row.enabled)?'启用':'停用')+'；'+row.timezone+'；'+(row.daily_time||new Date(Number(row.start_time)).toLocaleString()):kind==='ticket-rates'?row.rate:kind==='tickets'?'发行 '+row.num+'；剩余 '+row.remain:'奖励模板');
  const actions=cell(tr,'');if(row.disabled)cell(tr,'已停用');else actions.append(button('编辑',async()=>openOperation(row)));
  if(kind==='schedules')actions.append(button(Number(row.enabled)?'停用':'启用',async()=>{await api('/schedules/'+row.id,'PUT',{...row,enabled:!Number(row.enabled),match:JSON.parse(row.payload)});await loadOperations()}));
  if(kind==='tickets'&&!row.disabled)actions.append(button('发放给玩家',async()=>openIssue(row)),button('停用／删除种类',async()=>{if(!confirm('停止新增运营发放并从新比赛选择中移除；已发门票和原比赛权益保留。确认？'))return;await api('/tickets/'+row.id,'DELETE');await loadOperations()}));
  el('operationRows').append(tr);
 }
 notice('已更新');
 }finally{adminRefresh.finish(ticket)}
}
async function openOperation(row={}){
 const scope=adminRequests.sync(),version=++operationEditorVersion;
 setEditorLoading(el('operationEditor'),true);el('operationData').value='';
 issueRequest=null;
 const kind=el('operationKind').value;operationId=Number(row.id||0);originalOperation=structuredClone(row);el('operationEditor').classList.remove('hide');el('operationFields').replaceChildren();el('scheduleMatchFields').replaceChildren();el('operationTitle').textContent=(operationId?'编辑':'新增')+' '+kind;
 let data={...row};
 if(kind==='schedules'){
  data={schedule_kind:'daily',timezone:'Asia/Shanghai',daily_time:'12:00',start_time:Date.now()+3600000,enabled:1,...row};
  const input=inputField(el('operationFields'),'schedule_kind','类型','select');for(const [v,text]of [['daily','日常赛'],['once','定时赛']]){const o=document.createElement('option');o.value=v;o.textContent=text;input.append(o)}input.value=data.schedule_kind;input.dataset.initial=input.value;
  for(const [key,label,type]of [['timezone','运营时区','text'],['daily_time','每日开赛时间 HH:mm','text'],['start_time','定时开赛（本机时区）','date'],['enabled','启用','check']])inputField(el('operationFields'),key,label,type,data[key]);
  const template=row.payload?JSON.parse(row.payload):{championship_name:'',init_point:10000,min_player:2,max_player:100,register_gold:0,service_gold:0,small_blind:10,big_blind:20,currency:'CNY'};
  await fetchMetadata();adminRequests.assertScope(scope);if(version!==operationEditorVersion)throw adminRequests.stale();buildMatchFields(el('scheduleMatchFields'),template,true);data.match=template;delete data.payload;
 }else if(kind==='tickets'){
  data={name:'',price:0,currency:'CNY',match_id:0,num:0,remain:0,...row};
  for(const [key,label,type]of [['name','门票名称','text'],['price','面值（最小积分）','number'],['currency','币种','text'],['match_id','限定比赛 ID（0 通用）','number'],['num','发行量','number'],['remain','剩余库存（自动计算）','number']]){const input=inputField(el('operationFields'),key,label,type,data[key]);if(key==='remain')input.disabled=true;}
 }else if(kind==='ticket-rates'){
  data={currency:'CNY',rate:100,...row};inputField(el('operationFields'),'currency','币种','text',data.currency);inputField(el('operationFields'),'rate','每显示货币单位所需门票数','number',data.rate,1);
 }else{
  data={name:'',detail:[],...row};inputField(el('operationFields'),'name','奖励模板名称','text',data.name);
  const label=document.createElement('p');label.textContent='奖励明细在高级配置 detail 中填写：每名次 items 可包含 money（带币种）及 ticket（带门票 ID），金额使用最小积分单位。';el('operationFields').append(label);
 }
 el('operationData').value=JSON.stringify(data,null,2);
 setEditorLoading(el('operationEditor'),false);
}
el('operationEditor').onsubmit=e=>{e.preventDefault();submitForm(el('operationEditor'),async()=>{
 const scope=adminRequests.sync(),version=operationEditorVersion,id=operationId;
 const kind=el('operationKind').value,data=mergeFields(el('operationFields'),JSON.parse(el('operationData').value));
 if(kind==='schedules'){data.match=cleanMatch(mergeFields(el('scheduleMatchFields'),data.match));delete data.match.state;delete data.match.start_time;}
 delete data.id;delete data.create_time;delete data.update_time;delete data.agent_id;
 const check=()=>{adminRequests.assertScope(scope);if(version!==operationEditorVersion||kind!==el('operationKind').value)throw adminRequests.stale()};
 await editorRequest(check,'/'+kind+(id&&kind!=='ticket-rates'?'/'+id:''),id||kind==='ticket-rates'?'PUT':'POST',data);el('operationEditor').classList.add('hide');await loadOperations();notice('已保存');
})};
el('operationsTab').onclick=()=>switchTab('operations');el('operationKind').onchange=()=>{adminRefresh.invalidate();operationEditorVersion++;el('operationEditor').classList.add('hide');el('operationRows').replaceChildren();run(loadOperations)};el('newOperation').onclick=()=>run(()=>openOperation());el('closeOperation').onclick=()=>{operationEditorVersion++;el('operationEditor').classList.add('hide')};
el('showArchived').onchange=renderMatches;el('pendingOnly').onchange=renderMatches;
let issueRequest=null;
function openIssue(row){
 operationEditorVersion++;
 setEditorLoading(el('operationEditor'),false);
 const parent=el('operationFields');parent.replaceChildren();el('scheduleMatchFields').replaceChildren();el('operationEditor').classList.remove('hide');el('operationTitle').textContent='发放门票：'+row.name;
 const bytes=crypto.getRandomValues(new Uint8Array(16));issueRequest={id:row.id,count:1,userId:0,requestId:'ticket:'+Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')};
 inputField(parent,'userId','玩家 ID','number','',1);inputField(parent,'count','发放张数（最多 1000）','number',1,1);
 const p=document.createElement('p');p.textContent='从库存发到所选代理的真人账户。同一请求失败重试沿用原编号，成功后再次发放需重新打开。';parent.append(p);
 el('operationData').value=JSON.stringify(issueRequest,null,2);
}
const saveOperation=el('operationEditor').onsubmit;
el('operationEditor').onsubmit=e=>{
 if(!issueRequest)return saveOperation(e);e.preventDefault();submitForm(el('operationEditor'),async()=>{
  const scope=adminRequests.sync(),version=operationEditorVersion,original={...issueRequest},data=mergeFields(el('operationFields'),original);
  const check=()=>{adminRequests.assertScope(scope);if(version!==operationEditorVersion||issueRequest?.requestId!==original.requestId)throw adminRequests.stale()};
  await editorRequest(check,'/tickets/'+original.id+'/issue','POST',data);issueRequest=null;el('operationEditor').classList.add('hide');await loadOperations();notice('门票已发放');
 });
};
el('closeOperation').addEventListener('click',()=>issueRequest=null);el('newOperation').addEventListener('click',()=>issueRequest=null);el('operationKind').addEventListener('change',()=>issueRequest=null);
let lastRefresh=0;
const pageTimer=setInterval(()=>{
 if(document.hidden||tab!=='matches')return;adminRequests.sync();renderMatches();
 if(!el('token').value||Date.now()-lastRefresh<5000)return;
 const ticket=adminRefresh.background();if(!ticket)return;lastRefresh=Date.now();
 run(async()=>{try{matches=await viewRequest(ticket,'/matches');if(matches[0]?.admin?.serverNow)serverOffset=matches[0].admin.serverNow-Date.now();renderMatches()}finally{adminRefresh.finish(ticket)}});
},1000);
addEventListener('pagehide',()=>clearInterval(pageTimer),{once:true});
`;
