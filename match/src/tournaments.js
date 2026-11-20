import { rel } from './rel.js';

export async function createTournaments(runtime, matches) {
  const version = runtime.hotVersion;
  const { tournamentStore } = await rel(import.meta.url,'../../shared/rpc/tournaments.js',version);
  const { scheduleSlot } = await rel(import.meta.url,'./schedule.js',version);
  const {tournamentSnapshot,isTournamentParticipant:participant}=await rel(import.meta.url,'../../shared/tournament-snapshot.js',version);
  const repo = tournamentStore(runtime);
  if(runtime.env==='dev'){
    const {createDevTournamentStore}=await rel(import.meta.url,'../../cache/match/store.js',version);
    Object.assign(repo,createDevTournamentStore(runtime));
  }
  const { userCenterMatch } = await rel(import.meta.url,'../../shared/user-center-matches.js',version);
  const {lateRegistrationOpen,registrationOpen}=await rel(import.meta.url,'../../shared/tournament-registration.js',version);
  const {verifyTournamentCharge,tournamentPaymentMode}=await rel(import.meta.url,'../../shared/tournament-payment.js',version);
  const {terminationRequest}=await rel(import.meta.url,'./termination-request.js',version);
  const {tournamentEliminationOrder,validateTournamentFinalRanks}=await rel(import.meta.url,'../../shared/tournament-ranking.js',version);
  const {adminMatch}=await rel(import.meta.url,'./admin-match.js',version);
  const local = runtime.env === 'dev' ? await rel(import.meta.url,'../../cache/match/payments.js',version) : null;
  const {createMatchPayments}=await rel(import.meta.url,'./payments.js',version);
  const payments = runtime.matchPayments || local?.createDevMatchPayments(runtime)
    || (runtime.rpc?.common?.matchPayment ? createMatchPayments(runtime.rpc.common) : undefined);
  const now = () => runtime.clock ? runtime.clock() : Date.now();
  const failureTimeout=Number(runtime.config?.tournament_failure_timeout_ms??60000);
  if(!Number.isSafeInteger(failureTimeout)||failureTimeout<1000||failureTimeout>3600000)throw new Error('Invalid tournament failure timeout');
  const fail = (status,message) => Object.assign(new Error(message),{status});
  const active = e => e.status === 'registered' || e.status === 'playing';
  const amount = (value,name) => {
    const n = Number(value ?? 0);
    if (!Number.isSafeInteger(n) || n < 0) throw fail(400,name+' must be a nonnegative integer');
    return n;
  };
  function notify(row,state) {
    const players = tournamentSnapshot(row,state).players;
    row.current_player = players.length;
    row.current_live_player = players.filter(p=>p.status===4).length;
    state.seq = (state.seq||0)+1;
    // Full snapshots supersede older undelivered projections. A Redis outage
    // must not grow an unbounded quadratic list of complete player rosters.
    state.outbox=state.outbox.filter(e=>e.event!=='match_snapshot');
    state.outbox.push({id:state.seq,event:'match_snapshot',data:JSON.stringify(tournamentSnapshot(row,state))});
  }
  async function withMatch(id,work) {
    id=Number(id); if(!Number.isSafeInteger(id)||id<=0) throw fail(400,'invalid match id');
    const result=await repo.withMatch(id,async tx=>({value:await work(tx.row,tx.state)}));
    if(!result)throw fail(404,'比赛不存在');return result.value;
  }
  async function flush(id) {
    await withMatch(id,async (_row,state)=>{
      while(state.outbox.length){const e=state.outbox[0];await runtime.bus.publish('match',JSON.stringify({event:e.event,data:e.data}));state.outbox.shift();}
    });
  }
  async function identify(params) {
    const uid=Number(params.userId),token=params.token||params.userToken;
    if(!Number.isSafeInteger(uid)||uid<=0||!token)throw fail(401,'缺少登录凭证');
    const auth=await runtime.rpc.gateway.authenticate(String(token),uid);
    if(!auth.success||Number(auth.userId)!==uid)throw fail(401,'登录凭证无效');
    const profile=await runtime.rpc.gateway.getLoginData(uid);
    const agentId=Number(profile.agentId);
    if(!Number.isSafeInteger(agentId)||agentId<=0)throw fail(403,'代理身份无效');
    return {userId:uid,agentId,name:profile.userName||String(uid),avatar:profile.avatar||''};
  }
  function authorized(row,user) {
    const agent=Number(row.agent_id || (runtime.env==='dev'?1:0));
    if(agent!==user.agentId)throw fail(403,'无权访问该比赛');
  }
  const entryPayments=e=>e?[e,...(e.reentries||[])]:[];
  function paymentEntry(state,uid,key){const entry=state.registrations[uid];return key?entryPayments(entry).find(e=>e.plan.key===key):entry;}
  async function processEntry(id,uid,paymentKey) {
    // Authority acquires this same SQL match lock. Never call it while a
    // streamed withMatch transaction is open, or both requests would deadlock.
    for(let step=0;step<2;step++){
      const snapshot=await withMatch(id,(row,state)=>{
        const e=paymentEntry(state,uid,paymentKey);if(!e)return null;
        // Apply the current full-refund rule to existing schedules and matches.
        row.refund_service_fee=1;
        if(e.status==='pending'&&!registrationOpen(row,e,state.clock,now()))e.status='refund_pending';
        return structuredClone({entry:e,policy:1});
      });
      if(!snapshot)return null;
      const {entry,policy}=snapshot,plan=entry.plan;
      if(!['pending','refund_pending'].includes(entry.status))return entry;
      let receipt,error;
      try{
        if(plan.total>0||plan.ticketCount>0){
          if(!payments?.charge||!payments?.refund)throw fail(503,'比赛权威扣退款接口尚未接入');
          if(entry.status==='refund_pending'&&plan.service>0&&![0,1].includes(policy))throw fail(409,'尚未明确取消比赛时的服务费退款规则');
          receipt=entry.status==='pending'?await payments.charge(plan):await payments.refund(plan,policy===1);
        }else receipt=entry.status==='pending'?{key:plan.key}:{refunded:0};
        if(entry.status==='pending'){
          if(!receipt||receipt.key!==plan.key)throw fail(503,'扣款凭证不匹配');
          if(plan.ticketCredit)verifyTournamentCharge(plan,receipt);
          else{
            if(plan.total>0&&(receipt.paidGold!==plan.gold||receipt.paidService!==plan.service||receipt.currency!==plan.currency))throw fail(503,'扣款费用或币种凭证不匹配');
            if(plan.ticketCount>0&&(receipt.paidTicketCount!==plan.ticketCount||receipt.ticketId!==plan.ticketId))throw fail(503,'门票扣款凭证不匹配');
          }
        }else{
          if(!receipt)throw fail(503,'缺少退款凭证');
          if(plan.total||plan.ticketCount){
            if(receipt.key!==plan.key||receipt.currency!==plan.currency)throw fail(503,'退款凭证或币种不匹配');
            if(receipt.uncharged===true){if(entry.receipt||receipt.refunded!==0)throw fail(503,'已扣款记录不能按未支付完成退款');}
            else if(plan.ticketCredit){
              const charge=entry.receipt||receipt.chargeReceipt,{cash,tickets}=verifyTournamentCharge(plan,charge);
              if(receipt.refunded!==cash||receipt.restoredTickets!==tickets)throw fail(503,'原票据抵扣退款凭证不匹配');
            }else if(receipt.refunded!==plan.gold+(policy===1?plan.service:0)||plan.ticketCount>0&&receipt.restoredTickets!==plan.ticketCount)throw fail(503,'退款金额或门票凭证不匹配');
          }
        }
      }catch(caught){error=caught;}
      const current=await withMatch(id,(row,state)=>{
        const e=paymentEntry(state,uid,plan.key);if(!e||!['pending','refund_pending'].includes(e.status))return e;
        if(error){e.lastError=String(error.message).slice(0,300);if(error.status===409&&e.status==='pending'&&!e.receipt)e.status='failed';}
        else if(entry.status==='pending'){
          e.receipt=receipt;
          e.status=e.status==='pending'&&registrationOpen(row,e,state.clock,now())?'registered':'refund_pending';
          if(e.status==='registered'&&e.late)e.paidAt=now();
          delete e.lastError;
        }else{e.refund=receipt;e.status='refunded';delete e.lastError;}
        notify(row,state);return structuredClone(e);
      });
      if(error||current?.status!=='refund_pending')return current;
    }
    return withMatch(id,(_row,state)=>paymentEntry(state,uid,paymentKey)||null);
  }
  async function snapshot(user) {
    const rows=await runtime.store.listMatches(),result=[];
    for(const row of rows){
      if(Number(row.agent_id||(runtime.env==='dev'?1:0))!==user.agentId)continue;
      result.push(await withMatch(row.id,(r,s)=>tournamentSnapshot(r,s)));
    }
    return result;
  }
  async function register(id,user,paymentType=2) {
    if(![1,2].includes(paymentType))throw fail(400,'无效的报名支付方式');
    const initial=await runtime.store.getMatch(Number(id));
    let live;
    if(initial&&Number(initial.state)===2){
      authorized(initial,user);
      live=await tableRequest(id,'status',initial);
      if(!live)throw fail(409,'比赛已停止报名');
    }
    await withMatch(id,async(row,state)=>{
      authorized(row,user);
      const late=Number(row.state)===2;
      if(state.manualPause?.paused)throw fail(409,'比赛暂停中，暂不可报名');
      if(late&&live?.clock)state.clock=live.clock;
      if(late?!lateRegistrationOpen(row,state.clock,now()):Number(row.state)!==1||now()>=Number(row.start_time))throw fail(409,'本场报名已截止');
      const limit=Number(row.register_time_limit||0)*1000;
      if(limit>0&&now()<Number(row.start_time)-limit)throw fail(409,'尚未到报名时间');
      const old=state.registrations[user.userId];
      if(old&&['pending','registered','playing'].includes(old.status)){
        return;
      }
      if(late&&old&&['eliminated','winner'].includes(old.status))throw fail(409,'比赛重入功能尚未开放');
      if(old?.status==='refund_pending')throw fail(409,'上一笔退款尚未完成');
      const entries=Object.values(state.registrations).filter(e=>active(e)||e.status==='pending'||late&&['eliminated','winner'].includes(e.status));
      if(entries.length>=Math.min(Number(row.max_player)||5000,5000))throw fail(409,'比赛报名人数已满');
      if(!state.frozenBlinds&&runtime.tournamentTables?.blindPlan)state.frozenBlinds=await runtime.tournamentTables.blindPlan(row);
      const gold=amount(row.register_gold,'register_gold'),service=amount(row.service_gold,'service_gold');
      if(!Number.isSafeInteger(gold+service))throw fail(400,'报名金额超出范围');
      if((gold+service>0||Number(row.register_ticket)>0)&&!payments)throw fail(503,'比赛权威扣退款接口尚未接入');
      const attempt=(old?.attempt||0)+1;
      if(runtime.env==='dev'&&Number(row.register_ticket)>0&&!runtime.matchPayments)throw fail(503,'本地门票支付尚未配置');
      state.registrations[user.userId]={...user,attempt,late,status:'pending',points:amount(row.init_point,'init_point'),createdAt:now(),plan:tournamentPaymentMode({
        key:'match:'+user.agentId+':'+row.id+':'+user.userId+':'+attempt,userId:user.userId,agentId:user.agentId,matchId:Number(row.id),
        gold,service,total:gold+service,currency:row.currency||'CNY',ticketId:Number(row.ticket_id||0),ticketCount:amount(row.register_ticket,'register_ticket'),
      },row,paymentType)};
    });
    const e=await processEntry(id,user.userId);await flush(id);
    if(!active(e))throw fail(e.status==='failed'?409:503,e.lastError||'报名未完成，请稍后查询');
    return {registered:true};
  }
  async function unregister(id,user) {
    await withMatch(id,(row,state)=>{
      authorized(row,user);
      if(Number(row.state)!==1||now()>=Number(row.start_time))throw fail(409,'本场已停止退赛');
      const e=state.registrations[user.userId];
      if(e&&['pending','registered'].includes(e.status))e.status='refund_pending';
      notify(row,state);
    });
    const e=await processEntry(id,user.userId);await flush(id);
    if(e?.status==='refund_pending')throw fail(503,'退赛退款处理中');
    return {registered:false};
  }
  async function reenter(id,user,paymentType=2){
    if(![1,2].includes(paymentType))throw fail(400,'无效的报名支付方式');
    const row=await runtime.store.getMatch(Number(id));if(!row)throw fail(404,'比赛不存在');authorized(row,user);
    const live=Number(row.state)===2?await tableRequest(id,'status',row):null;
    if(!live)throw fail(409,'本场已停止复活');
    if(Number(live.rebuyLimit||0)!==Number(row.rebuy_time||0))throw fail(503,'游戏服未确认本场复活配置，暂不扣费');
    const key=await withMatch(id,(r,s)=>{
      if(s.manualPause?.paused)throw fail(409,'比赛暂停中，暂不可复活');
      authorized(r,user);if(live.clock)s.clock=live.clock;
      const e=s.registrations[user.userId];if(!e)throw fail(409,'首次参赛请使用报名入口');
      const last=e.reentries?.at(-1);
      if(last&&(['pending','registered'].includes(last.status)||e.status==='playing'&&last.status==='admitted')){
        return last.plan.key;
      }
      if(!lateRegistrationOpen(r,s.clock,now()))throw fail(409,'本场复活窗口已截止');
      const limit=Number(r.rebuy_time||0),used=(e.reentries||[]).filter(x=>x.status==='admitted').length;
      if(!Number.isSafeInteger(limit)||limit<=0||limit>100||used>=limit)throw fail(409,'本场复活次数已用完');
      if(e.status!=='eliminated'||e.points!==0)throw fail(409,'只有已确认淘汰的玩家可以复活');
      if(last?.status==='refund_pending')throw fail(409,'上一笔复活退款尚未完成');
      if((e.reentries?.length||0)>=200)throw fail(409,'本场复活请求已达上限');
      const attempt=Math.max(e.attempt,...(e.reentries||[]).map(x=>x.attempt))+1;
      const request={userId:e.userId,agentId:e.agentId,name:e.name,avatar:e.avatar,attempt,late:true,reentry:true,reentryNumber:used+1,
        points:amount(r.init_point,'init_point'),status:'pending',createdAt:now(),plan:tournamentPaymentMode({...e.plan,key:`match:${user.agentId}:${r.id}:${user.userId}:${attempt}`},r,paymentType)};
      (e.reentries||=[]).push(request);return request.plan.key;
    });
    const entry=await processEntry(id,user.userId,key);await flush(id);
    if(!['registered','admitted'].includes(entry?.status))throw fail(entry?.status==='failed'?409:503,entry?.lastError||'复活支付尚未确认');
    return {registered:true,reentered:true};
  }
  async function cancel(id,reason='admin_cancelled') {
    await withMatch(id,(row,state)=>{
      if(Number(row.state)===4)return;
      if(![0,1,4].includes(Number(row.state)))throw fail(409,'进行中的比赛不能按赛前退款取消');
      row.state=4;row.end_time=now();state.cancelReason=reason;
      for(const e of Object.values(state.registrations))if(['registered','pending'].includes(e.status))e.status='refund_pending';
      notify(row,state);
    });
    await drain(id);return runtime.store.getMatch(Number(id));
  }
  async function drain(id) {
    const users=await withMatch(id,(_r,s)=>Object.values(s.registrations).flatMap(entryPayments).filter(e=>['pending','refund_pending'].includes(e.status)).map(e=>({uid:e.userId,key:e.plan.key})));
    for(const {uid,key}of users)await processEntry(id,uid,key);
    await flush(id);
  }
  async function start(id) {
    await withMatch(id,async(row,state)=>{
      if(Number(row.state)!==1||now()<Number(row.start_time))return;
      const players=Object.values(state.registrations).filter(active);
      if(players.length<Number(row.min_player||2)) {
        row.state=4;row.end_time=now();state.cancelReason='insufficient_players';
        for(const e of Object.values(state.registrations))if(['registered','pending'].includes(e.status))e.status='refund_pending';
      } else {
        if(!runtime.tournamentTables?.start)throw fail(503,'比赛牌桌调度尚未就绪');
        const tables=await runtime.tournamentTables.start(row,players,state.frozenBlinds);
        if(!Array.isArray(tables)||!tables.length)throw fail(503,'比赛分桌未完成');
        state.tables=tables;
        if(tables.processId)state.gameServerProcessId=tables.processId;
        for(const e of players){const t=tables.find(t=>t.players?.includes(e.userId));if(!t)throw fail(503,'玩家未分桌');e.roomId=t.room_id;e.status='playing';}
        row.state=2;state.startedAt=now();
      }
      notify(row,state);
    });
    await drain(id);
  }
  async function saveSchedule(id,body) {
    const row={agent_id:amount(body.agent_id,'agent_id'),schedule_kind:body.schedule_kind,timezone:body.timezone||'Asia/Shanghai',
      daily_time:body.daily_time||'',start_time:Number(body.start_time||0),enabled:body.enabled===false||body.enabled===0?0:1};
    if(row.agent_id<=0)throw fail(400,'agent_id is required');
    if(id){
      const old=(await repo.listSchedules()).find(item=>Number(item.id)===Number(id));
      if(!old)throw fail(404,'排期不存在');
      if(Number(old.agent_id)!==row.agent_id)throw fail(403,'不能修改排期所属代理');
    }
    const template=await matches.prepare({...body.match,agent_id:row.agent_id});
    if(template.state!==undefined&&Number(template.state)!==0)throw fail(400,'schedule template cannot supply runtime state');
    row.payload=JSON.stringify(template);
    try{scheduleSlot({...row,id:Number(id)||1},now());}catch(error){throw fail(400,error.message);}
    return repo.saveSchedule(Number(id)||0,row);
  }
  async function update(id,body) {
    const saved=await withMatch(id,async(row,state)=>{
      if(body.agent_id!==undefined&&Number(body.agent_id)!==Number(row.agent_id))throw fail(403,'不能修改比赛所属代理');
      const locked=Number(row.state)>=2||Object.values(state.registrations).some(e=>active(e)||e.status==='pending'||e.status==='refund_pending');
      if(body.state!==undefined&&Number(body.state)!==Number(row.state))throw fail(409,'请使用比赛状态接口');
      if(locked){
        const allowed=['championship_name','consults'];
        if(Object.keys(body).some(k=>!allowed.includes(k)))throw fail(409,'已有报名或已开赛，费用、筹码、盲注和奖励结构已锁定');
        for(const k of allowed)if(body[k]!==undefined)row[k]=body[k];
      }else Object.assign(row,await matches.prepare({...row,...body}));
      notify(row,state);return row;
    });
    await flush(id);return saved;
  }
  async function openRegistration(id) {
    const saved=await withMatch(id,async(row,state)=>{
      if(Number(row.state)!==0)throw fail(409,'只有草稿比赛可以开放报名');
      if(Number(row.start_time)<=now())throw fail(409,'比赛开赛时间已过');
      Object.assign(row,await matches.prepare(row),{state:1});notify(row,state);return row;
    });await flush(id);return saved;
  }
  async function syncPause(id){
    const command=await withMatch(id,(row,state)=>Number(row.state)===2&&state.manualPause&&state.manualPause.ackVersion!==state.manualPause.version
      ?{row,version:state.manualPause.version,paused:state.manualPause.paused}:null);
    if(!command)return;
    if(!runtime.tournamentTables?.pause)throw fail(503,'游戏服尚不支持人工暂停');
    const result=await runtime.tournamentTables.pause(command.row,{paused:command.paused,pauseVersion:command.version});
    if(!result?.clock||result.clock.pauseVersion!==command.version||Boolean(result.clock.pauseRequested)!==command.paused)throw fail(503,'游戏服暂停回执不匹配');
    await withMatch(id,(row,state)=>{
      if(Number(row.state)!==2||state.manualPause?.version!==command.version)return;
      state.manualPause.ackVersion=command.version;state.clock=result.clock;notify(row,state);
    });await flush(id);
  }
  async function setPause(id,paused,actor){
    if(typeof paused!=='boolean')throw fail(400,'paused 必须为布尔值');
    await withMatch(id,(row,state)=>{
      if(Number(row.state)!==2||state.invalidated)throw fail(409,'只有进行中的比赛可以暂停或恢复');
      if(state.manualPause?.paused===paused&&(state.manualPause.ackVersion!==state.manualPause.version||!(paused===false&&state.clock?.pauseRequested)))return;
      state.manualPause={paused,version:Math.max(state.manualPause?.version||0,state.clock?.pauseVersion||0)+1,at:now(),actor:{agentId:actor.agentId,kind:actor.kind}};
      state.pauseHistory=[...(state.pauseHistory||[]),state.manualPause].slice(-100);
      if(paused){state.clock||={};state.clock.pauseRequested=true;}
      notify(row,state);
    });await flush(id);await syncPause(id);
    return withMatch(id,(row,state)=>adminMatch(row,state,now()));
  }
  async function archive(id,actor){
    const saved=await withMatch(id,(row,state)=>{
      if(![3,4].includes(Number(row.state)))throw fail(409,'请先结束或取消比赛，再归档');
      state.archived||={at:now(),actor:{agentId:actor.agentId,kind:actor.kind}};notify(row,state);return adminMatch(row,state,now());
    });await flush(id);return saved;
  }
  async function removeDraft(id){
    // The storage implementation repeats all checks atomically at deletion.
    await withMatch(id,(row,state)=>{
      if(Number(row.state)!==0||Object.keys(state.registrations||{}).length||state.tables?.length||state.prizes?.length)throw fail(409,'只有没有报名和资金记录的草稿可以删除');
    });
    if(typeof runtime.store.deleteMatch!=='function')throw fail(503,'后端草稿删除接口尚未发布');
    const row=await runtime.store.deleteMatch(id);
    if(!row)throw fail(404,'比赛不存在');
    await runtime.bus.publish('match',JSON.stringify({event:'match_delete',data:JSON.stringify({id})}));return {id,deleted:true};
  }
  async function listAdmin(agentId){
    const rows=[];
    for(const row of await runtime.store.listMatches())if(Number(row.agent_id)===agentId){
      const saved=await repo.readMatch(row.id);
      if(saved&&Number(saved.row.agent_id)===agentId)rows.push(adminMatch(saved.row,saved.state,now()));
    }return rows;
  }
  async function poll(id) {
    if(!runtime.tournamentTables?.status||!runtime.tournamentTables?.advance)return;
    const current=await withMatch(id,(r,s)=>Number(r.state)===2?{checkpoint:s.checkpoint||null,paused:Boolean(s.manualPause?.paused)}:null);
    if(!current)return;
    if(current.paused){
      const row=await runtime.store.getMatch(Number(id)),result=await tableRequest(id,'status',row);
      if(result?.clock)await withMatch(id,(r,s)=>{if(Number(r.state)===2&&s.manualPause?.paused){s.clock=result.clock;notify(r,s);}});
      return;
    }
    let checkpoint=current.checkpoint;
    if(!checkpoint){
      const row=await runtime.store.getMatch(Number(id));
      const result=await tableRequest(id,'status',row);if(!result)return;
      if(result.clock){
        const changed=await withMatch(id,(r,s)=>{
          if(Number(r.state)!==2||JSON.stringify(s.clock)===JSON.stringify(result.clock))return false;
          s.clock=result.clock;notify(r,s);return true;
        });
        if(changed)await flush(id);
      }
      if(!result.ready)return;
      checkpoint=await withMatch(id,(r,s)=>{
        if(Number(r.state)!==2||s.invalidated)return null;
        if(s.checkpoint)return s.checkpoint;
        const playing=Object.values(s.registrations).filter(e=>e.status==='playing');
        const ids=new Set(result.players.map(p=>p.uid));
        if(result.players.length!==playing.length||ids.size!==result.players.length||playing.some(e=>!ids.has(e.userId))||result.players.some(p=>!Number.isSafeInteger(p.point)||p.point<0))throw fail(503,'比赛结算名单或积分无效');
        if(playing.reduce((n,e)=>n+e.points,0)!==result.players.reduce((n,p)=>n+p.point,0))throw fail(503,'比赛积分不守恒，暂停推进');
        const bust=tournamentEliminationOrder(result.players.filter(p=>p.point===0));
        for(const [index,p] of bust.entries()){
          const e=s.registrations[p.uid];e.status='eliminated';e.points=0;e.rank=playing.length-index;
        }
        const alive=result.players.filter(p=>p.point>0).sort((a,b)=>b.point-a.point||a.uid-b.uid);
        for(const [index,p] of alive.entries()){
          const e=s.registrations[p.uid];e.points=p.point;e.rank=index+1;e.roomId=p.roomId;
        }
        s.checkpoint={revision:result.revision,ranks:Object.fromEntries(Object.values(s.registrations).filter(participant).map(e=>[e.userId,e.rank])),
          admissions:Object.values(s.registrations).flatMap(entryPayments).filter(e=>e.late&&e.status==='registered').map(e=>({uid:e.userId,name:e.name,icon:e.avatar,point:e.points,key:e.plan.key,...(e.reentry?{reentry:true,reentryNumber:e.reentryNumber}:{})}))};
        notify(r,s);return s.checkpoint;
      });
    }
    if(!checkpoint)return;
    const row=await runtime.store.getMatch(Number(id)),result=await tableRequest(id,'advance',row,checkpoint);if(!result)return;
    await withMatch(id,(r,s)=>{
      if(Number(r.state)!==2||s.invalidated)return;
      if(s.checkpoint?.revision!==checkpoint.revision)return;
      const expected=new Map(Object.values(s.registrations).filter(e=>e.status==='playing').map(e=>[e.userId,e.points]));
      for(const admission of checkpoint.admissions||[])expected.set(admission.uid,admission.point);
      if(!Array.isArray(result.players)||result.players.length!==expected.size||new Set(result.players.map(p=>p.uid)).size!==expected.size
        ||result.players.some(p=>!expected.has(p.uid)||!Number.isSafeInteger(p.point)||p.point!==expected.get(p.uid)||!Number.isSafeInteger(p.roomId)||p.roomId<=0)
        ||Boolean(result.finished)!==(expected.size<=1&&!result.waitingForReentry))throw fail(503,'比赛分桌确认名单或积分不一致，暂停推进');
      if(!Array.isArray(result.tables)||new Set(result.tables.map(t=>t.room_id)).size!==result.tables.length)throw fail(503,'比赛分桌确认房间无效');
      const assigned=new Map();
      for(const table of result.tables){
        if(!Number.isSafeInteger(table.room_id)||table.room_id<=0||!Array.isArray(table.players))throw fail(503,'比赛分桌确认房间无效');
        for(const uid of table.players){if(assigned.has(uid)||!expected.has(uid))throw fail(503,'比赛分桌玩家重复或未知');assigned.set(uid,table.room_id);}
      }
      if(assigned.size!==expected.size||result.players.some(p=>assigned.get(p.uid)!==p.roomId))throw fail(503,'比赛分桌房号与名单不一致');
      s.tables=result.tables;
      for(const admission of checkpoint.admissions||[]){
        const e=s.registrations[admission.uid],payment=paymentEntry(s,admission.uid,admission.key),p=result.players.find(p=>p.uid===admission.uid);
        if(!e||!payment||payment.status!=='registered'||!p||payment.reentry&&e.status!=='eliminated')throw fail(503,'比赛入桌凭证不匹配');
        if(payment.reentry){payment.status='admitted';payment.admittedAt=now();}
        e.status='playing';e.points=admission.point;e.roomId=p.roomId;e.admittedAt=now();
      }
      // Late entrants increase the total field size. Shift every prior bust
      // exactly once, after the admission checkpoint is confirmed.
      const eliminated=Object.values(s.registrations).filter(e=>e.status==='eliminated').sort((a,b)=>b.rank-a.rank||a.userId-b.userId);
      const field=Object.values(s.registrations).filter(e=>['playing','eliminated'].includes(e.status)).length;
      for(const [index,entry]of eliminated.entries())entry.rank=field-index;
      const survivors=Object.values(s.registrations).filter(e=>e.status==='playing').sort((a,b)=>b.points-a.points||a.userId-b.userId);
      for(const [index,entry]of survivors.entries())entry.rank=index+1;
      for(const p of result.players){const e=s.registrations[p.uid];if(e)e.roomId=p.roomId;}
      if(result.finished){
        r.state=3;r.end_time=now();
        for(const e of Object.values(s.registrations))if(e.status==='playing')e.status='winner';
        for(const e of Object.values(s.registrations).flatMap(entryPayments))if(e.late&&['registered','pending'].includes(e.status))e.status='refund_pending';
        // Keep a visible, durable pending award state until authority confirms payment.
        s.awardsPending=Boolean(r.award_json&&JSON.parse(r.award_json).length);
      }
      delete s.checkpoint;notify(r,s);
    });
    await flush(id);
    await drain(id);
  }
  function voidRunningMatch(row,state,reason,message,termination){
      if(Number(row.state)!==2||state.invalidated)return false;
      const at=now();
      state.invalidated={reason,at,gameServerProcessId:state.gameServerProcessId||'',
        message:String(message||reason).slice(0,300),tables:structuredClone(state.tables||[]),checkpoint:state.checkpoint||null};
      if(termination)state.termination={...termination,at};
      row.state=4;row.end_time=at;state.cancelReason=termination?'admin_terminated':'game_server_failure';
      delete state.checkpoint;delete state.clock;state.tables=[];state.tablesReleased=false;state.awardsPending=false;
      for(const e of Object.values(state.registrations))if(['pending','registered','playing','eliminated','winner'].includes(e.status)){
        e.invalidated=true;e.invalidRank=e.rank||0;e.rank=0;e.status='refund_pending';
        for(const request of e.reentries||[])if(['pending','registered','admitted'].includes(request.status))request.status='refund_pending';
      }
      for(const prize of state.prizes||[])if(prize.status!=='paid')prize.status='cancelled';
      notify(row,state);return true;
  }
  async function terminate(id,scope,reason){
    const request=terminationRequest(scope,reason);
    await withMatch(id,(row,state)=>{
      authorized(row,{agentId:request.actor.agentId});
      if(Number(row.state)===4&&state.termination){
        if(state.termination.reason!==request.reason)throw fail(409,'本场已终止，原操作原因不可覆盖');
        return;
      }
      if(Number(row.state)!==2||state.invalidated)throw fail(409,'只有进行中的比赛可以强制终止');
      if(state.prizes?.some(p=>p.status==='paid'))throw fail(409,'本场已有已付奖励，不能按在局作废处理');
      voidRunningMatch(row,state,'ADMIN_TERMINATED',request.reason,request);
    });
    // The terminal decision is durable before touching the game process or
    // wallet. Both cleanup and original refunds remain retryable after errors.
    await closeInvalidTables(id);await drain(id);
    return withMatch(id,(row,state)=>({...row,terminated:true,terminationReason:state.termination.reason,terminationAt:state.termination.at,
      refundsPending:Object.values(state.registrations).flatMap(entryPayments).filter(e=>e.status==='refund_pending').length,
      tableCleanupPending:!state.tablesReleased}));
  }
  async function invalidate(id,reason,error){
    const changed=await withMatch(id,(row,state)=>voidRunningMatch(row,state,reason,error?.message));
    if(changed){await flush(id);await closeInvalidTables(id);await drain(id);}
    return changed;
  }
  async function closeInvalidTables(id){
    const row=await withMatch(id,(row,state)=>state.invalidated&&!state.tablesReleased?structuredClone(row):null);
    if(!row||!runtime.tournamentTables?.invalidate)return;
    try{
      const response=await runtime.tournamentTables.invalidate(row);
      if(response?.invalidated===true&&response.released===true)await withMatch(id,(row,state)=>{if(state.invalidated){state.tablesReleased=true;notify(row,state);}});
    }catch(error){runtime.log.error('invalid tournament table cleanup pending',id,error.message);}
  }
  async function tableRequest(id,operation,row,...args){
    let result;
    try{result=await runtime.tournamentTables[operation](row,...args);}
    catch(error){
      if(error.reason==='MATCH_STATE_LOST'){await invalidate(id,'GAME_STATE_LOST',error);return null;}
      if([503,504].includes(Number(error.status))){
        const expired=await withMatch(id,(r,s)=>{
          if(Number(r.state)!==2||s.invalidated)return false;
          const previous=s.gameServerFailure;
          s.gameServerFailure={firstSeen:previous?.firstSeen??now(),lastSeen:now(),count:Math.min(1000,(previous?.count||0)+1),message:String(error.message).slice(0,300)};
          return s.gameServerFailure.count>=3&&now()-s.gameServerFailure.firstSeen>=failureTimeout;
        });
        if(expired){await invalidate(id,'GAME_SERVER_UNREACHABLE',error);return null;}
      }
      throw error;
    }
    const status=await withMatch(id,(r,s)=>{
      if(Number(r.state)!==2||s.invalidated)return 'closed';
      if(result.processId&&s.gameServerProcessId&&result.processId!==s.gameServerProcessId)return 'changed';
      if(result.processId)s.gameServerProcessId=result.processId;
      delete s.gameServerFailure;return 'ok';
    });
    if(status==='changed'){await invalidate(id,'GAME_SERVER_PROCESS_CHANGED',new Error('比赛游戏服进程已更换'));return null;}
    return status==='ok'?result:null;
  }
  async function awards(id) {
    await withMatch(id,(row,state)=>{
      if(Number(row.state)!==3)return;
      validateTournamentFinalRanks(Object.values(state.registrations).filter(participant));
      if(state.prizes)return;
      const config=JSON.parse(row.award_json||'[]');
      state.prizes=[];
      for(const e of Object.values(state.registrations).filter(participant)){
        const items=config.find(a=>Number(a.rank)===e.rank)?.items||[];
        for(const [index,item] of items.entries())state.prizes.push({status:'pending',plan:{
          key:'match:'+e.agentId+':'+row.id+':award:'+e.userId+':'+index,agentId:e.agentId,matchId:Number(row.id),userId:e.userId,
          kind:item.kind,currency:item.currency||row.currency,amount:Number(item.amount),ticketId:Number(item.ticketId||0),
        }});
      }
      state.awardsPending=state.prizes.length>0;
    });
    const plans=await withMatch(id,(row,state)=>Number(row.state)===3?state.prizes.filter(p=>p.status!=='paid').slice(0,32).map(p=>structuredClone(p.plan)):[]);
    for(const plan of plans){
      let receipt,error;
      try{
        if(!payments?.award)throw fail(503,'比赛奖励权威发放接口尚未接入');
        receipt=await payments.award(plan);
        if(receipt?.key!==plan.key||receipt.amount!==plan.amount||receipt.currency!==plan.currency
          ||plan.kind==='ticket'&&(receipt.kind!=='ticket'||receipt.ticketId!==plan.ticketId))throw fail(503,'奖励凭证不匹配');
      }catch(caught){error=caught;}
      await withMatch(id,(_row,state)=>{
        const prize=state.prizes?.find(p=>p.plan.key===plan.key);if(!prize||prize.status==='paid')return;
        if(error)prize.lastError=String(error.message).slice(0,300);
        else{prize.receipt=receipt;prize.status='paid';delete prize.lastError;}
      });
    }
    const ready=await withMatch(id,(row,state)=>{
      if(Number(row.state)!==3)return false;
      state.awardsPending=state.prizes.some(p=>p.status!=='paid');
      return !state.awardsPending&&(!state.awardsNotified||state.awardsDeliveryVersion!==2);
    });
    if(ready&&runtime.tournamentTables?.awards){
      const data=await withMatch(id,(row,s)=>({row,results:Object.values(s.registrations).filter(participant).map(e=>({uid:e.userId,rank:e.rank,
        award:s.prizes.filter(p=>p.plan.userId===e.userId&&p.plan.kind==='money').reduce((n,p)=>n+p.plan.amount,0),
        ticketNum:s.prizes.filter(p=>p.plan.userId===e.userId&&p.plan.kind==='ticket').reduce((n,p)=>n+p.plan.amount,0),
      }))}));
      await runtime.tournamentTables.awards(data.row,data.results);
      await withMatch(id,(_r,s)=>{s.awardsNotified=true;s.awardsDeliveryVersion=2;});
    }
    const cleanupRow=await withMatch(id,(row,state)=>state.awardsNotified&&!state.awardsPending&&!state.tablesReleased?structuredClone(row):null);
    if(cleanupRow&&runtime.tournamentTables?.cleanup){
      const result=await runtime.tournamentTables.cleanup(cleanupRow);
      if(result?.released===true)await withMatch(id,(row,state)=>{
        if(state.awardsPending||!state.awardsNotified)return;
        state.tablesReleased=true;state.tables=[];notify(row,state);
      });
    }
  }
  async function tick() {
    for(const schedule of await repo.listSchedules()){
      if(!schedule.enabled)continue;
      try{
        let slot=scheduleSlot(schedule,now());const template=JSON.parse(schedule.payload);
        // Expose the next signup; today's existing occurrence remains in the due scan.
        if(schedule.schedule_kind==='daily'&&slot.startTime<=now())slot=scheduleSlot(schedule,now(),true);
        const row=await repo.ensureOccurrence(schedule,slot,{...template,agent_id:schedule.agent_id,state:1,start_time:slot.startTime,
          current_player:0,current_live_player:0,create_time:Math.floor(now()/1000),update_time:Math.floor(now()/1000)});
        if(row)await withMatch(row.id,(r,s)=>{if(!s.announced){s.announced=true;notify(r,s);}});
      }catch(error){runtime.log.error('tournament schedule failed',schedule.id,error.message);}
    }
    for(const row of await runtime.store.listMatches()){
      try{
        // Decide at the deadline before processing any still-pending payment.
        if(Number(row.state)===1&&Number(row.start_time)<=now())await start(row.id);
        else if(Number(row.state)===2){await syncPause(row.id);await poll(row.id);await drain(row.id);}
        else if(Number(row.state)===3){await drain(row.id);await awards(row.id);}
        else {await closeInvalidTables(row.id);await drain(row.id);}
        await withMatch(row.id,(r,s)=>{
          if(!s.lastBroadcastAt||now()-s.lastBroadcastAt>=30000){s.lastBroadcastAt=now();notify(r,s);}
        });await flush(row.id);
      }catch(error){runtime.log.error('tournament tick failed',row.id,error.message);}
    }
  }
  async function history(user,query){
    if(!query||!['matches','match'].includes(query.kind)||!Number.isFinite(query.startTime)||!Number.isFinite(query.endTime)
      ||query.startTime>query.endTime||query.endTime-query.startTime>31*86400000)throw fail(400,'Invalid tournament history query');
    const profile=await runtime.rpc.gateway.getLoginData(user.userId);
    const scope={...query,userId:user.userId,agentId:user.agentId,currency:profile.currency?.symbol||'CNY'},records=[];
    if(runtime.env!=='dev')return runtime.rpc.gateway.getUserCenter(scope);
    for(const row of await runtime.store.listMatches()){
      if(Number(row.agent_id)!==user.agentId)continue;
      const saved=await repo.readMatch(row.id),record=saved&&userCenterMatch(saved.row,saved.state,scope);if(record)records.push(record);
    }
    records.sort((a,b)=>b.startDate-a.startDate||b.id-a.id);
    return query.kind==='match'?{match:records[0]||null}:{matches:records,totalScore:records.reduce((n,r)=>n+r.net,0)};
  }
  return {identify,snapshot,history,register,reenter,unregister,cancel,terminate,start,tick,poll,saveSchedule,update,openRegistration,awards,setPause,archive,removeDraft,listAdmin,
    listSchedules:()=>repo.listSchedules(),inspect:id=>withMatch(id,(row,state)=>({row,state})),flush};
}
