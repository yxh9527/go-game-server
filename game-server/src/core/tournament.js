import { rel } from '../rel.js';

export async function createTournamentControl(runtime,gameOf,ioOf) {
  const {verifyControl,controlError}=await rel(import.meta.url,'../../../shared/tournament-control.js',runtime.hotVersion);
  const {PUSH}=await rel(import.meta.url,'../messages.js',runtime.hotVersion);
  const {createTournamentIdempotency,tournamentRequestKey}=await rel(import.meta.url,'../../../shared/tournament-idempotency.js',runtime.hotVersion);
  const dedup=createTournamentIdempotency(runtime);
  const secret=runtime.config?.match_control_secret || (runtime.env==='dev'
    ? (await rel(import.meta.url,'../../../cache/match/control.js',runtime.hotVersion)).devControlSecret : '');
  const resident=runtime.tournamentRooms ||= {matches:new Map(),nextRoomId:81000000};
  const payment=runtime.env==='dev'?(await rel(import.meta.url,'../../../cache/match/wallet.js',runtime.hotVersion)).createDevTournamentWallet(runtime,ioOf):null;
  const keyOf=(agent,id)=>agent+':'+id;
  function snapshot(m) {
    return {revision:m.revision||0,tables:m.tables.filter(t=>!t.mtt.closed).map(t=>({match_id:m.id,room_id:t.roomId,room_index:t.mtt.index,
      player_nums:t.members.filter(p=>p.point>0).length,players:t.members.map(p=>p.uid)})),
      players:m.tables.flatMap(t=>t.members.map(p=>({uid:p.uid,point:p.point,openingPoint:p.openingPoint??p.point,roomId:t.roomId}))),
      ready:m.tables.every(t=>t.phase!=='playing'&&(t.mtt.closed||t.mtt.paused&&Date.now()>=t.startAt)),finished:Boolean(m.finished)};
  }
  function start(body) {
    const {agentId,matchId,config,players}=body,key=keyOf(agentId,matchId);
    const old=resident.matches.get(key);
    if(old){
      if(JSON.stringify(old.roster)!==JSON.stringify(players.map(p=>p.uid)))throw controlError(409,'比赛分桌请求与原报名名单冲突');
      return snapshot(old);
    }
    if(!config||!Array.isArray(config.levels)||!config.levels.length||!Array.isArray(players)||players.length<2||players.length>5000)throw controlError(400,'比赛人数或配置无效');
    const ids=new Set();
    for(const p of players){
      if(!Number.isSafeInteger(p.uid)||p.uid<=0||ids.has(p.uid)||!Number.isSafeInteger(p.point)||p.point<=0||p.point!==config.initPoint)throw controlError(400,'比赛初始积分或玩家名单无效');
      ids.add(p.uid);
    }
    const level=config.levels[0];
    if(!Number.isSafeInteger(level.min)||level.min<=0||!Number.isSafeInteger(level.max)||level.max<level.min||!Number.isSafeInteger(level.bet)||level.bet<0)throw controlError(400,'比赛盲注无效');
    const game=gameOf(101),count=Math.ceil(players.length/game.config.maxPeople),groups=Array.from({length:count},()=>[]);
    players.forEach((p,i)=>groups[i%count].push(p));
    const m={id:matchId,agentId,config,roster:players.map(p=>p.uid),tables:[],revision:0};
    // Validate the entire roster before allocating any real table or chair.
    for(const [index,group] of groups.entries()){
      while([...runtime.registry.tables.values()].some(t=>t.roomId===resident.nextRoomId))resident.nextRoomId++;
      const table=game.createTable(resident.nextRoomId++,101,{room_type:101,play_mode:0,small_blind:level.min,big_blind:level.max,
        initial_bet:level.bet,ante:level.bet,carry_min:0,force_show_card:config.forceShowCard?1:0,game_room_config_id:0});
      table.agentId=agentId;table.mtt={id:matchId,index:index+1,level:0,config,paused:false};
      table.members=group.map((p,pos)=>({uid:p.uid,name:p.name,icon:p.icon,point:p.point,pos,state:1,bot:false,
        lastOperation:0,totalBet:0,streetBet:0,dealer:false,clubId:0}));
      table.standby=false;game.queueStart(table);
      runtime.registry.setTable(table.roomId,table,agentId,game.id);m.tables.push(table);
    }
    resident.matches.set(key,m);return snapshot(m);
  }
  function advance(m,body) {
    // Lost acknowledgments and repeated scheduler calls may not apply a checkpoint twice.
    if(Number(body.revision)<m.revision)return snapshot(m);
    if(Number(body.revision)!==m.revision||!snapshot(m).ready)throw controlError(409,'比赛牌局尚未全部结算');
    const game=gameOf(101),live=m.tables.flatMap(t=>t.members).filter(p=>p.point>0);
    for(const table of m.tables){
      for(const p of table.members.filter(p=>p.point<=0)){
        ioOf(table).broadcast(PUSH.USER_STANDUP_ROOM,p.uid);
        const session=[...runtime.registry.sessions.values()].find(s=>s.userId===p.uid&&s.agentId===m.agentId);
        if(session)game.watch({...table,members:table.members.filter(x=>x.uid!==p.uid)},session);
      }
      table.members=table.members.filter(p=>p.point>0);
    }
    if(live.length<=1){
      m.finished=true;
      for(const t of m.tables){t.mtt.finished=true;ioOf(t).broadcast(20007,{mttId:m.id});}
      // Prize notifications are emitted only by an acknowledged award provider.
      m.revision++;return snapshot(m);
    }
    const count=Math.ceil(live.length/game.config.maxPeople),targets=m.tables.slice(0,count);
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
        ioOf(t).broadcast(PUSH.ROOM_INFO,game.roomInfo(t));
      }
    }
    m.revision++;return snapshot(m);
  }
  async function handle(ws,body) {
    try{
      const p=verifyControl(secret,body);
      if(!Number.isSafeInteger(p.agentId)||p.agentId<=0||!Number.isSafeInteger(p.matchId)||p.matchId<=0)throw controlError(400,'比赛身份无效');
      const data=p.action==='status'?await dispatch(p):await dedup.run('control:'+tournamentRequestKey(p),()=>dispatch(p));
      if(ws.readyState===1)ws.send(JSON.stringify({code:200,data}));
    }catch(error){if(ws.readyState===1)ws.send(JSON.stringify({code:error.status||503,error:error.message}));}
  }
  async function dispatch(p) {
      let data;
      if(p.action==='payment'){
        if(!payment)throw controlError(403,'本地比赛钱包不适用于生产');
        data=await payment(p);
      } else if(p.action==='start')data=start(p);
      else {
        const m=resident.matches.get(keyOf(p.agentId,p.matchId));
        if(!m)throw controlError(404,'比赛牌桌不存在');
        if(p.action==='advance')data=advance(m,p);
        else if(p.action==='awards'){
          if(!m.finished)throw controlError(409,'比赛尚未结束');
          for(const item of p.results||[]){
            if(!m.roster.includes(item.uid))throw controlError(400,'奖励玩家不在本场名单');
            const table=m.tables.find(t=>t.members.some(x=>x.uid===item.uid))||m.tables[0];
            // Send directly to authenticated participants, including players already eliminated/moved.
            for(const [ws,session] of runtime.registry.sessions)if(session.agentId===m.agentId&&session.userId===item.uid&&session.inRoom!==false
              &&m.tables.some(t=>t.roomId===session.roomId))ioOf(table).send(ws,20010,{mttId:m.id,...item,bounty:0,isFinal:true,isDisuse:item.rank!==1});
          }
          data={acknowledged:true};
        }
        else if(p.action==='status')data=snapshot(m);
        else throw controlError(400,'未知比赛调度操作');
      }
      return data;
  }
  return {handle,snapshot};
}
