import { rel } from '../rel.js';
import {randomUUID} from 'node:crypto';

export async function createTournamentControl(runtime,gameOf,ioOf) {
  const {verifyControl,controlError}=await rel(import.meta.url,'../../../shared/tournament-control.js',runtime.hotVersion);
  const {PUSH}=await rel(import.meta.url,'../messages.js',runtime.hotVersion);
  const {normalizeTournamentLevels,blindAt,updateTournamentClock,tournamentRestSeconds,resumeTournamentClock}=await rel(import.meta.url,'../../../shared/tournament-blinds.js',runtime.hotVersion);
  const {lateRegistrationOpen}=await rel(import.meta.url,'../../../shared/tournament-registration.js',runtime.hotVersion);
  const {validateTournamentFinalRanks}=await rel(import.meta.url,'../../../shared/tournament-ranking.js',runtime.hotVersion);
  const {createTournamentIdempotency,tournamentRequestKey}=await rel(import.meta.url,'../../../shared/tournament-idempotency.js',runtime.hotVersion);
  const dedup=createTournamentIdempotency(runtime);
  const secret=runtime.config?.match_control_secret || (runtime.env==='dev'
    ? (await rel(import.meta.url,'../../../cache/match/control.js',runtime.hotVersion)).devControlSecret : '');
  const resident=runtime.tournamentRooms ||= {matches:new Map(),nextRoomId:81000000};
  resident.processId||=randomUUID();
  const payment=runtime.env==='dev'?(await rel(import.meta.url,'../../../cache/match/wallet.js',runtime.hotVersion)).createDevTournamentWallet(runtime,ioOf):null;
  const keyOf=(agent,id)=>agent+':'+id;
  const now=()=>runtime.clock?.()??Date.now();
  const reportsReady=m=>runtime.env!=='prod'||m.tables.every(t=>t.userCenterReportsReady?.()===true);
  function revivalWindow(m){return lateRegistrationOpen({state:2,start_time:m.config.startedAt,delay_register_level:m.config.lateLevel,delay_register_time:m.config.lateSeconds},{...m.clock,...blindAt(m.config,now(),m.clock)},now());}
  function canWaitForReentry(m){return Number(m.config.rebuyLimit)>0&&revivalWindow(m)&&m.roster.some(uid=>!m.tables.some(t=>t.members.some(p=>p.uid===uid&&p.point>0))&&(m.reentries?.get(uid)||0)<m.config.rebuyLimit);}
  const cleanupDelay=Number(runtime.config?.tournament_cleanup_delay_ms??60000);
  if(!Number.isSafeInteger(cleanupDelay)||cleanupDelay<0||cleanupDelay>3600000)throw controlError(400,'比赛回收等待时间无效');
  function syncClock(m){
    const previous=m.clock?.waitingIndex,wasResting=m.clock?.restUntil,previousPause=m.clock?.autoPauseIndex;
    const clock=updateTournamentClock(m,now());
    if(clock.autoPauseIndex!=null&&clock.autoPauseIndex!==previousPause)m.pauseVersion=(m.pauseVersion||0)+1;
    if(clock.waitingIndex!=null&&previous!==clock.waitingIndex)for(const t of m.tables)ioOf(t).broadcast(20013);
    if(clock.restUntil!=null&&clock.restUntil!==wasResting)for(const t of m.tables)ioOf(t).broadcast(20014,tournamentRestSeconds(clock,now()));
    return clock;
  }
  function snapshot(m) {
    const clock=syncClock(m);
    const reportingPending=!reportsReady(m);
    const {nextUpBlindTime,...blind}=blindAt(m.config,now(),clock);
    return {processId:resident.processId,rebuyLimit:Number(m.config.rebuyLimit||0),revision:m.revision||0,tables:m.tables.filter(t=>!t.mtt.closed).map(t=>({match_id:m.id,room_id:t.roomId,room_index:t.mtt.index,
      player_nums:t.members.filter(p=>p.point>0).length,players:t.members.map(p=>p.uid)})),
      players:m.tables.flatMap(t=>t.members.map(p=>({uid:p.uid,point:p.point,openingPoint:p.openingPoint??p.point,roomId:t.roomId}))),
      clock:{...blind,restUntil:clock.restUntil||0,waitingForRest:clock.waitingIndex!=null&&!clock.restUntil,
        pauseRequested:Boolean(clock.pauseRequested),pauseAt:clock.pauseAt??null,registrationDelayMs:clock.registrationDelayMs||0,pauseVersion:m.pauseVersion||0,
        autoPauseIndex:clock.autoPauseIndex??null,completedPauseIndex:clock.completedPauseIndex??-1},
      waitingForReentry:Boolean(m.waitingForReentry&&canWaitForReentry(m)),
      reportingPending,
      ready:!reportingPending&&!clock.pauseRequested&&clock.waitingIndex==null&&m.tables.every(t=>!t.hand&&t.phase!=='playing'&&(t.mtt.closed||t.mtt.paused&&now()>=t.startAt)),finished:Boolean(m.finished)};
  }
  function start(body) {
    const {agentId,matchId,config,players}=body,key=keyOf(agentId,matchId);
    const old=resident.matches.get(key);
    if(old){
      if(JSON.stringify(old.roster)!==JSON.stringify(players.map(p=>p.uid)))throw controlError(409,'比赛分桌请求与原报名名单冲突');
      return snapshot(old);
    }
    if(!config||!Array.isArray(config.levels)||!config.levels.length||!Array.isArray(players)||players.length<2||players.length>5000)throw controlError(400,'比赛人数或配置无效');
    try{config.levels=normalizeTournamentLevels(config.levels);}catch(error){throw controlError(400,error.message);}
    if(!Number.isSafeInteger(config.startedAt)||config.startedAt<0)throw controlError(400,'比赛开赛时钟无效');
    if(config.rebuyLimit!=null&&(!Number.isSafeInteger(config.rebuyLimit)||config.rebuyLimit<0||config.rebuyLimit>100))throw controlError(400,'比赛复活次数无效');
    const ids=new Set();
    for(const p of players){
      if(!Number.isSafeInteger(p.uid)||p.uid<=0||ids.has(p.uid)||!Number.isSafeInteger(p.point)||p.point<=0||p.point!==config.initPoint)throw controlError(400,'比赛初始积分或玩家名单无效');
      ids.add(p.uid);
    }
    const level=config.levels[0];
    if(!Number.isSafeInteger(level.min)||level.min<=0||!Number.isSafeInteger(level.max)||level.max<level.min||!Number.isSafeInteger(level.bet)||level.bet<0)throw controlError(400,'比赛盲注无效');
    const game=gameOf(101),count=Math.ceil(players.length/game.config.maxPeople),groups=Array.from({length:count},()=>[]);
    players.forEach((p,i)=>groups[i%count].push(p));
    const m={id:matchId,agentId,config,roster:players.map(p=>p.uid),reentries:new Map(),tables:[],revision:0,clock:{delayMs:0,completedRestIndex:-1}};
    // Validate the entire roster before allocating any real table or chair.
    for(const [index,group] of groups.entries()){
      const table=allocateTable(m,index);
      table.members=group.map((p,pos)=>({uid:p.uid,name:p.name,icon:p.icon,point:p.point,pos,state:1,bot:false,
        lastOperation:0,totalBet:0,streetBet:0,dealer:false,clubId:0}));
      table.standby=false;game.queueStart(table);
    }
    resident.matches.set(key,m);return snapshot(m);
  }
  function allocateTable(m,index){
    const game=gameOf(101),level=blindAt(m.config,now(),m.clock);
    while([...runtime.registry.tables.values()].some(t=>t.roomId===resident.nextRoomId))resident.nextRoomId++;
    const table=game.createTable(resident.nextRoomId++,101,{room_type:101,play_mode:0,small_blind:level.smallBlind,big_blind:level.bigBlind,
      initial_bet:level.ante,ante:level.ante,carry_min:0,force_show_card:m.config.forceShowCard?1:0,game_room_config_id:0});
    table.agentId=m.agentId;table.mtt={id:m.id,index:index+1,level:level.index,config:m.config,clock:m.clock,paused:false};
    runtime.registry.setTable(table.roomId,table,m.agentId,game.id);m.tables.push(table);return table;
  }
  function advance(m,body) {
    // Lost acknowledgments and repeated scheduler calls may not apply a checkpoint twice.
    if(Number(body.revision)<m.revision)return snapshot(m);
    if(Number(body.revision)!==m.revision||!snapshot(m).ready)throw controlError(409,'比赛牌局尚未全部结算');
    const admissions=body.admissions||[],seen=new Set();
    if(!Array.isArray(admissions)||m.finished||m.roster.length+admissions.filter(p=>!p.reentry).length>5000)throw controlError(409,'晚报名分桌名单无效');
    for(const p of admissions){
      if(!Number.isSafeInteger(p.uid)||p.uid<=0||seen.has(p.uid)||p.point!==m.config.initPoint||!Number.isSafeInteger(p.point)||p.point<=0
        ||typeof p.key!=='string'||!p.key.startsWith(`match:${m.agentId}:${m.id}:${p.uid}:`))throw controlError(400,'晚报名积分或报名凭证无效');
      if(p.reentry){
        const used=m.reentries?.get(p.uid)||0;
        if(!m.roster.includes(p.uid)||m.tables.some(t=>t.members.some(m=>m.uid===p.uid&&m.point>0))||p.reentryNumber!==used+1||p.reentryNumber>Number(m.config.rebuyLimit||0))throw controlError(409,'复活凭证或次数无效');
      }else if(m.roster.includes(p.uid))throw controlError(409,'玩家已经参加比赛');
      seen.add(p.uid);
    }
    const game=gameOf(101);
    for(const p of admissions){
      const used=new Set(m.tables[0].members.map(p=>p.pos));
      const pos=Array.from({length:game.config.maxPeople},(_,i)=>i).find(i=>!used.has(i))??-1;
      m.tables[0].members.push({uid:p.uid,name:p.name,icon:p.icon,point:p.point,pos,state:1,bot:false,lastOperation:0,totalBet:0,streetBet:0,dealer:false,clubId:0});
      if(p.reentry){m.reentries||=new Map();m.reentries.set(p.uid,p.reentryNumber);}else m.roster.push(p.uid);
    }
    const live=m.tables.flatMap(t=>t.members).filter(p=>p.point>0);
    for(const table of m.tables){
      for(const p of table.members.filter(p=>p.point<=0)){
        ioOf(table).broadcast(PUSH.USER_STANDUP_ROOM,p.uid);
        const session=[...runtime.registry.sessions.values()].find(s=>s.userId===p.uid&&s.agentId===m.agentId);
        if(session)game.watch({...table,members:table.members.filter(x=>x.uid!==p.uid)},session);
      }
      table.members=table.members.filter(p=>p.point>0);
      const used=new Set(table.members.filter(p=>p.pos>=0).map(p=>p.pos));
      for(const p of table.members)if(p.pos<0){const free=Array.from({length:game.config.maxPeople},(_,i)=>i).find(i=>!used.has(i));if(free!=null){p.pos=free;used.add(free);}}
    }
    if(live.length<=1){
      if(canWaitForReentry(m)){
        m.waitingForReentry=true;
        for(const t of m.tables){t.mtt.paused=true;ioOf(t).broadcast(20013);}
        m.revision++;return snapshot(m);
      }
      m.finished=true;
      for(const t of m.tables){t.mtt.finished=true;ioOf(t).broadcast(20007,{mttId:m.id});}
      // Prize notifications are emitted only by an acknowledged award provider.
      m.revision++;return snapshot(m);
    }
    delete m.waitingForReentry;
    const count=Math.ceil(live.length/game.config.maxPeople);
    while(m.tables.length<count)allocateTable(m,m.tables.length);
    const targets=m.tables.slice(0,count);
    const min=Math.floor(live.length/count),max=Math.ceil(live.length/count);
    // Keep current seats whenever possible; move only overflow/closed-table players.
    const moving=[];
    for(const t of m.tables){
      const limit=targets.includes(t)?max:0;
      while(t.members.length>limit)moving.push({member:t.members.pop(),from:t});
    }
    for(const target of targets){
      while(target.members.length<min&&moving.length){const p=moving.shift();relocate(p,target);}
    }
    while(moving.length){const target=targets.slice().sort((a,b)=>a.members.length-b.members.length)[0];relocate(moving.shift(),target);}
    function relocate({member,from},target){
      ioOf(from).broadcast(PUSH.USER_STANDUP_ROOM,member.uid);
      const used=new Set(target.members.map(p=>p.pos));member.pos=Array.from({length:game.config.maxPeople},(_,i)=>i).find(p=>!used.has(p));
      target.members.push(member);
      ioOf(from).sendUser(member.uid,20004,{mttId:m.id,roomId:target.roomId});
      // Client reconnect/join chooses its new table from the authoritative room id.
    }
    for(const t of m.tables){
      t.mtt.closed=!targets.includes(t);t.mtt.paused=t.mtt.closed;
      if(t.mtt.closed)ioOf(t).forEachPlayer(s=>{
        if(!live.some(p=>p.uid===s.userId))ioOf(t).send(s.ws,20004,{mttId:m.id,roomId:targets[0].roomId});
      });
      if(!t.mtt.closed){
        for(const p of t.members){p.hole=[];p.folded=false;p.allIn=false;p.streetBet=0;p.totalBet=0;p.lastOperation=0;}
        t.phase='starting';t.startAt=Math.max(t.startAt,Date.now()+500);
        t.mtt.reentries=m.reentries;
        for(const [ws,session] of runtime.registry.sessions)if(session.agentId===m.agentId&&session.inRoom!==false&&session.roomId===t.roomId){
          ioOf(t).send(ws,4199,Math.max(0,Number(m.config.rebuyLimit||0)-(m.reentries?.get(session.userId)||0)));
        }
        ioOf(t).broadcast(PUSH.ROOM_INFO,game.roomInfo(t));
      }
    }
    m.revision++;return snapshot(m);
  }
  function setPause(m,p){
    syncClock(m);
    if(m.finished||m.invalidated)throw controlError(409,'比赛已结束');
    if(typeof p.paused!=='boolean'||!Number.isSafeInteger(p.pauseVersion)||p.pauseVersion<1)throw controlError(400,'暂停指令无效');
    const version=m.pauseVersion||0;
    if(p.pauseVersion<version)return snapshot(m);
    if(p.pauseVersion===version){
      if(Boolean(m.clock.pauseRequested)!==p.paused)throw controlError(409,'暂停指令版本冲突');
      return snapshot(m);
    }
    if(p.paused){m.clock.pauseRequested=true;for(const table of m.tables)ioOf(table).broadcast(20013);}
    else{
      try{resumeTournamentClock(m.clock,now());}catch(error){throw controlError(409,error.message)}
    }
    m.pauseVersion=p.pauseVersion;return snapshot(m);
  }
  function removeFinished(m){
    if(!m.invalidated&&(!m.finished||!m.awardsAcknowledged||!reportsReady(m)||m.tables.some(t=>t.hand||t.phase==='playing')))throw controlError(409,'比赛尚有未完成牌局、回放或奖励通知');
    // Competition points are never cashed out. Keep the authenticated socket
    // alive and detach its room before discarding table-local references.
    for(const table of m.tables){
      for(const [ws,session]of runtime.registry.sessions){
        if(Number(session.agentId)!==m.agentId||Number(session.roomId)!==table.roomId||session.gameId!==table.gameId)continue;
        session.inRoom=false;
        if(session.roomLeave?.table===table)delete session.roomLeave;
        ioOf(table).send(ws,PUSH.ROOM_DISSMISS,{roomId:table.roomId});
      }
      table.members=[];table.observers=[];table.history=[];table.hand=null;
      table.fairCodes?.clear();table.playerPanelHands?.clear();table.playerPanelBots?.clear();
      table.roomFeatures?.players?.clear();delete table.roomFeatures;
      table.mtt.finalResults?.clear();table.retired=true;
      if(runtime.registry.getTable(table.roomId,table.agentId,table.gameId)===table)runtime.registry.removeTable(table.roomId,table.agentId,table.gameId);
    }
    m.tables=[];m.finalResults?.clear();resident.matches.delete(keyOf(m.agentId,m.id));
  }
  function cleanup(m){
    if(!m.finished||!m.awardsAcknowledged)throw controlError(409,'比赛尚未确认最终奖励通知');
    m.cleanupAt??=now()+cleanupDelay;
    if(now()<m.cleanupAt)return {released:false,cleanupAt:m.cleanupAt};
    if(!reportsReady(m)||m.tables.some(t=>t.hand||t.phase==='playing')||[...runtime.registry.sessions.values()].some(s=>s.leaveTask&&s.roomLeave?.table?.mtt?.id===m.id&&Number(s.agentId)===m.agentId))
      return {released:false,cleanupAt:m.cleanupAt};
    removeFinished(m);return {released:true};
  }
  function tick(){
    for(const m of [...resident.matches.values()]){
      syncClock(m);
      if(m.cleanupAt!=null&&now()>=m.cleanupAt)cleanup(m);
    }
  }
  async function handle(ws,body) {
    try{
      const p=verifyControl(secret,body);
      if(!Number.isSafeInteger(p.agentId)||p.agentId<=0||!Number.isSafeInteger(p.matchId)||p.matchId<=0)throw controlError(400,'比赛身份无效');
      const data=['status','cleanup','invalidate','pause'].includes(p.action)?await dispatch(p):await dedup.run('control:'+tournamentRequestKey(p),()=>dispatch(p));
      if(ws.readyState===1)ws.send(JSON.stringify({code:200,data}));
    }catch(error){if(ws.readyState===1)ws.send(JSON.stringify({code:error.status||503,error:error.message,reason:error.reason}));}
  }
  async function dispatch(p) {
      let data;
      if(p.action==='payment'){
        if(!payment)throw controlError(403,'本地比赛钱包不适用于生产');
        data=await payment(p);
      } else if(p.action==='start'){
        // After a completed table is reclaimed, an old signed start must not
        // recreate it when the short response cache expires.
        if(runtime.env==='prod'){
          const row=await runtime.rpc?.lobby?.getMatch(p.matchId);
          if(!row||Number(row.agent_id)!==p.agentId||![1,2].includes(Number(row.state)))throw controlError(409,'比赛已结束或不允许创建牌桌');
        }
        data=start(p);
      }
      else {
        const m=resident.matches.get(keyOf(p.agentId,p.matchId));
        if(!m&&p.action==='invalidate')return {invalidated:true,released:true};
        if(!m&&p.action==='cleanup')return {released:true};
        if(!m)throw Object.assign(controlError(404,'比赛牌桌不存在'),{reason:'MATCH_STATE_LOST'});
        if(p.action==='invalidate'){
          if(m.awardsAcknowledged)throw controlError(409,'已确认最终奖励的比赛不可按异常在局作废');
          m.invalidated=true;
          removeFinished(m);return {invalidated:true,released:true};
        }
        if(p.action==='pause')data=setPause(m,p);
        else if(p.action==='advance')data=advance(m,p);
        else if(p.action==='awards'){
          if(!m.finished)throw controlError(409,'比赛尚未结束');
          try{validateTournamentFinalRanks(p.results);}catch(error){throw controlError(400,error.message);}
          if(!Array.isArray(p.results)||p.results.length!==m.roster.length||new Set(p.results.map(item=>item.uid)).size!==m.roster.length
            ||p.results.some(item=>!m.roster.includes(item.uid)||!Number.isSafeInteger(item.rank)||item.rank<1||item.rank>m.roster.length
              ||![item.award,item.ticketNum].every(n=>Number.isSafeInteger(n)&&n>=0)))throw controlError(400,'最终奖励通知名单或金额无效');
          const digest=JSON.stringify(p.results);
          if(m.awardsAcknowledged){if(m.awardsDigest!==digest)throw controlError(409,'最终奖励通知与原记录冲突');return {acknowledged:true};}
          m.finalResults=new Map();
          for(const item of p.results||[]){
            if(!m.roster.includes(item.uid))throw controlError(400,'奖励玩家不在本场名单');
            const table=m.tables.find(t=>t.members.some(x=>x.uid===item.uid))||m.tables[0];
            // Send directly to authenticated participants, including players already eliminated/moved.
            const result={mttId:m.id,...item,bounty:0,isFinal:true,isDisuse:item.rank!==1};
            m.finalResults.set(item.uid,result);
            for(const [ws,session] of runtime.registry.sessions)if(session.agentId===m.agentId&&session.userId===item.uid&&session.inRoom!==false
              &&m.tables.some(t=>t.roomId===session.roomId))ioOf(table).send(ws,20010,result);
          }
          for(const table of m.tables)table.mtt.finalResults=m.finalResults;
          m.awardsDigest=digest;m.awardsAcknowledged=true;
          data={acknowledged:true};
        }
        else if(p.action==='cleanup')data=cleanup(m);
        else if(p.action==='status')data=snapshot(m);
        else throw controlError(400,'未知比赛调度操作');
      }
      return data;
  }
  return {handle,snapshot,tick};
}
