import { rel } from './rel.js';

export async function createTournaments(runtime, matches) {
  const version = runtime.hotVersion;
  const { tournamentStore } = await rel(import.meta.url,'../../shared/rpc/tournaments.js',version);
  const { scheduleSlot } = await rel(import.meta.url,'./schedule.js',version);
  const {tournamentSnapshot,isTournamentParticipant:participant}=await rel(import.meta.url,'../../shared/tournament-snapshot.js',version);
  const repo = tournamentStore(runtime);
  const local = runtime.env === 'dev' ? await rel(import.meta.url,'../../cache/match/payments.js',version) : null;
  const payments = runtime.matchPayments || local?.createDevMatchPayments(runtime);
  const now = () => runtime.clock ? runtime.clock() : Date.now();
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
  async function processEntry(id,uid) {
    return withMatch(id,async(row,state)=>{
      const e=state.registrations[uid];if(!e)return null;
      if(!['pending','refund_pending'].includes(e.status))return e;
      if(e.plan.total>0||e.plan.ticketCount>0) {
        if(!payments?.charge||!payments?.refund)throw fail(503,'比赛权威扣退款接口尚未接入');
      }
      try {
        if(e.status==='pending' && Number(row.state)===1 && now()<Number(row.start_time)) {
          e.receipt=e.plan.total||e.plan.ticketCount ? await payments.charge(e.plan) : {key:e.plan.key};
          if(!e.receipt||e.receipt.key!==e.plan.key)throw fail(503,'扣款凭证不匹配');
          if(e.plan.total>0&&(e.receipt.paidGold!==e.plan.gold||e.receipt.paidService!==e.plan.service||e.receipt.currency!==e.plan.currency))throw fail(503,'扣款费用或币种凭证不匹配');
          if(e.plan.ticketCount>0&&(e.receipt.paidTicketCount!==e.plan.ticketCount||e.receipt.ticketId!==e.plan.ticketId))throw fail(503,'门票扣款凭证不匹配');
          e.status=now()<Number(row.start_time)?'registered':'refund_pending';
        } else if(e.status==='pending') e.status='refund_pending';
        if(e.status==='refund_pending') {
          const policy=Number(row.refund_service_fee??0);
          if(e.plan.service>0&&![0,1].includes(policy))throw fail(409,'尚未明确取消比赛时的服务费退款规则');
          e.refund=e.plan.total||e.plan.ticketCount ? await payments.refund(e.plan,policy===1) : {refunded:0};
          if(!e.refund)throw fail(503,'缺少退款凭证');
          if(e.plan.total||e.plan.ticketCount){
            if(e.refund.key!==e.plan.key||e.refund.currency!==e.plan.currency)throw fail(503,'退款凭证或币种不匹配');
            if(e.refund.uncharged===true){
              if(e.receipt||e.refund.refunded!==0)throw fail(503,'已扣款记录不能按未支付完成退款');
            }else{
              const expected=e.plan.gold+(policy===1?e.plan.service:0);
              if(e.refund.refunded!==expected)throw fail(503,'退款金额凭证不匹配');
              if(e.plan.ticketCount>0&&e.refund.restoredTickets!==e.plan.ticketCount)throw fail(503,'门票退回凭证不匹配');
            }
          }
          e.status='refunded';
        }
        delete e.lastError;
      } catch(error) {
        e.lastError=String(error.message).slice(0,300);
        // A definitive decline spends nothing; an ambiguous response stays pending.
        if(error.status===409&&e.status==='pending'&&!e.receipt)e.status='failed';
      }
      notify(row,state);return e;
    });
  }
  async function snapshot(user) {
    const rows=await runtime.store.listMatches(),result=[];
    for(const row of rows){
      if(Number(row.agent_id||(runtime.env==='dev'?1:0))!==user.agentId)continue;
      result.push(await withMatch(row.id,(r,s)=>tournamentSnapshot(r,s)));
    }
    return result;
  }
  async function register(id,user) {
    await withMatch(id,async(row,state)=>{
      authorized(row,user);
      if(Number(row.state)!==1||now()>=Number(row.start_time))throw fail(409,'本场报名已截止');
      const limit=Number(row.register_time_limit||0)*1000;
      if(limit>0&&now()<Number(row.start_time)-limit)throw fail(409,'尚未到报名时间');
      const old=state.registrations[user.userId];
      if(old&&['pending','registered','playing'].includes(old.status))return;
      if(old?.status==='refund_pending')throw fail(409,'上一笔退款尚未完成');
      const entries=Object.values(state.registrations).filter(e=>active(e)||e.status==='pending');
      if(entries.length>=Math.min(Number(row.max_player)||5000,5000))throw fail(409,'比赛报名人数已满');
      if(!state.frozenBlinds&&runtime.tournamentTables?.blindPlan)state.frozenBlinds=await runtime.tournamentTables.blindPlan(row);
      const gold=amount(row.register_gold,'register_gold'),service=amount(row.service_gold,'service_gold');
      if(!Number.isSafeInteger(gold+service))throw fail(400,'报名金额超出范围');
      if((gold+service>0||Number(row.register_ticket)>0)&&!payments)throw fail(503,'比赛权威扣退款接口尚未接入');
      const attempt=(old?.attempt||0)+1;
      if(runtime.env==='dev'&&Number(row.register_ticket)>0&&!runtime.matchPayments)throw fail(503,'本地门票支付尚未配置');
      state.registrations[user.userId]={...user,attempt,status:'pending',points:amount(row.init_point,'init_point'),createdAt:now(),plan:{
        key:'match:'+user.agentId+':'+row.id+':'+user.userId+':'+attempt,userId:user.userId,agentId:user.agentId,matchId:Number(row.id),
        gold,service,total:gold+service,currency:row.currency||'CNY',ticketId:Number(row.ticket_id||0),ticketCount:amount(row.register_ticket,'register_ticket'),
      }};
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
  async function cancel(id,reason='admin_cancelled') {
    await withMatch(id,(row,state)=>{
      if(![0,1,4].includes(Number(row.state)))throw fail(409,'进行中的比赛不能按赛前退款取消');
      row.state=4;row.end_time=now();state.cancelReason=reason;
      for(const e of Object.values(state.registrations))if(['registered','pending'].includes(e.status))e.status='refund_pending';
      notify(row,state);
    });
    await drain(id);return runtime.store.getMatch(Number(id));
  }
  async function drain(id) {
    const users=await withMatch(id,(_r,s)=>Object.values(s.registrations).filter(e=>['pending','refund_pending'].includes(e.status)).map(e=>e.userId));
    for(const uid of users)await processEntry(id,uid);
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
  async function poll(id) {
    if(!runtime.tournamentTables?.status||!runtime.tournamentTables?.advance)return;
    let checkpoint=await withMatch(id,(_r,s)=>s.checkpoint||null);
    if(!checkpoint){
      const row=await runtime.store.getMatch(Number(id));
      const result=await runtime.tournamentTables.status(row);
      if(!result.ready)return;
      checkpoint=await withMatch(id,(r,s)=>{
        if(s.checkpoint)return s.checkpoint;
        const playing=Object.values(s.registrations).filter(e=>e.status==='playing');
        const ids=new Set(result.players.map(p=>p.uid));
        if(ids.size!==result.players.length||playing.some(e=>!ids.has(e.userId))||result.players.some(p=>!Number.isSafeInteger(p.point)||p.point<0))throw fail(503,'比赛结算名单或积分无效');
        if(playing.reduce((n,e)=>n+e.points,0)!==result.players.reduce((n,p)=>n+p.point,0))throw fail(503,'比赛积分不守恒，暂停推进');
        const bust=result.players.filter(p=>p.point<=0).sort((a,b)=>(a.openingPoint-b.openingPoint)||a.uid-b.uid);
        for(const [index,p] of bust.entries()){
          const e=s.registrations[p.uid];e.status='eliminated';e.points=0;e.rank=playing.length-index;
        }
        const alive=result.players.filter(p=>p.point>0).sort((a,b)=>b.point-a.point||a.uid-b.uid);
        for(const [index,p] of alive.entries()){
          const e=s.registrations[p.uid];e.points=p.point;e.rank=index+1;e.roomId=p.roomId;
        }
        s.checkpoint={revision:result.revision,ranks:Object.fromEntries(Object.values(s.registrations).filter(participant).map(e=>[e.userId,e.rank]))};
        notify(r,s);return s.checkpoint;
      });
    }
    const row=await runtime.store.getMatch(Number(id)),result=await runtime.tournamentTables.advance(row,checkpoint);
    await withMatch(id,(r,s)=>{
      if(s.checkpoint?.revision!==checkpoint.revision)return;
      s.tables=result.tables;
      for(const p of result.players){const e=s.registrations[p.uid];if(e)e.roomId=p.roomId;}
      if(result.finished){
        r.state=3;r.end_time=now();
        for(const e of Object.values(s.registrations))if(e.status==='playing')e.status='winner';
        // Keep a visible, durable pending award state until authority confirms payment.
        s.awardsPending=Boolean(r.award_json&&JSON.parse(r.award_json).length);
      }
      delete s.checkpoint;notify(r,s);
    });
    await flush(id);
  }
  async function awards(id) {
    await withMatch(id,(row,state)=>{
      if(Number(row.state)!==3||state.prizes)return;
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
    const ready=await withMatch(id,async(row,state)=>{
      if(Number(row.state)!==3)return false;
      for(const prize of state.prizes){
        if(prize.status==='paid')continue;
        try{
          if(!payments?.award)throw fail(503,'比赛奖励权威发放接口尚未接入');
          prize.receipt=await payments.award(prize.plan);
          if(prize.receipt?.key!==prize.plan.key||prize.receipt.amount!==prize.plan.amount||prize.receipt.currency!==prize.plan.currency)throw fail(503,'奖励凭证不匹配');
          prize.status='paid';delete prize.lastError;
        }catch(error){prize.lastError=String(error.message).slice(0,300);}
      }
      state.awardsPending=state.prizes.some(p=>p.status!=='paid');
      return !state.awardsPending&&!state.awardsNotified;
    });
    if(ready&&runtime.tournamentTables?.awards){
      const data=await withMatch(id,(row,s)=>({row,results:Object.values(s.registrations).filter(participant).map(e=>({uid:e.userId,rank:e.rank,
        award:s.prizes.filter(p=>p.plan.userId===e.userId&&p.plan.kind==='money').reduce((n,p)=>n+p.plan.amount,0),
        ticketNum:s.prizes.filter(p=>p.plan.userId===e.userId&&p.plan.kind==='ticket').reduce((n,p)=>n+p.plan.amount,0),
      }))}));
      await runtime.tournamentTables.awards(data.row,data.results);
      await withMatch(id,(_r,s)=>{s.awardsNotified=true;});
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
        else if(Number(row.state)===2)await poll(row.id);
        else if(Number(row.state)===3)await awards(row.id);
        else await drain(row.id);
        await withMatch(row.id,(r,s)=>{
          if(!s.lastBroadcastAt||now()-s.lastBroadcastAt>=30000){s.lastBroadcastAt=now();notify(r,s);}
        });await flush(row.id);
      }catch(error){runtime.log.error('tournament tick failed',row.id,error.message);}
    }
  }
  return {identify,snapshot,register,unregister,cancel,start,tick,poll,saveSchedule,update,openRegistration,awards,
    listSchedules:()=>repo.listSchedules(),inspect:id=>withMatch(id,(row,state)=>({row,state})),flush};
}
