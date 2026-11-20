import { rel } from '../rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {projectUserCenter,holdemUserCenterDetail}=await rel(import.meta.url,'../../../shared/user-center.js',version);
const {captureHoldemReplay}=await rel(import.meta.url,'../../../shared/holdem-replay-store.js',version);
const {captureNativeHistory}=await rel(import.meta.url,'./game-history.js',version);
const carryKey=Symbol.for('gogame.cash.carry.member'),TTL=31*86400000;
const tournamentReportsKey=Symbol.for('gogame.tournament.completedReports');
const isScore=value=>Number.isSafeInteger(value);

export function installUserCenter(runtime,legacyRecords) {
  const state=runtime.userCenterState ||= {records:new Map(),outgoing:new Map(),writeTask:null};
  // Older resident versions may have initialized only the local records map.
  state.records||=new Map();state.outgoing||=new Map();
  function prune(){const now=Date.now();for(const [id,r]of state.records)if(now-r.endedAt>TTL)state.records.delete(id);while(state.records.size>50000)state.records.delete(state.records.keys().next().value);}
  function sessionFor(table,uid,member){return member?.departureSession || member?.[carryKey]?.session
    || table.playerSessions?.get(uid) || [...runtime.registry.sessions.values()].find(s=>Number(s.userId)===uid&&Number(s.agentId)===Number(table.agentId));}
  async function flush(){
    if(runtime.env!=='prod'||!state.outgoing.size||state.writeTask)return state.writeTask;
    const gateway=runtime.gateway||runtime.rpc?.gateway;
    delete state.retryAt;delete state.failures;
    const batch=[];let bytes=0;
    for(const r of state.outgoing.values()){
      const length=Buffer.byteLength(JSON.stringify(r));if(batch.length&&(batch.length>=100||bytes+length>8*1024*1024))break;
      batch.push(r);bytes+=length;
    }
    const task=Promise.resolve().then(()=>{if(!gateway?.writeUserCenter)throw new Error('战绩写入入口未配置');return gateway.writeUserCenter(batch);}).then(receipt=>{
      if(receipt?.durable!==true||receipt.stored!==batch.length)throw new Error('战绩持久化回执未确认');
    })
      .catch(error=>{runtime.log.error('user-center ES write failed; no retry',{message:error.message,recordIds:batch.map(r=>r.id)});})
      .finally(()=>{for(const r of batch)if(state.outgoing.get(r.id)===r)state.outgoing.delete(r.id);});
    state.writeTask=task;task.finally(()=>{if(state.writeTask===task)state.writeTask=null;});return task;
  }
  function remember(records,barrier){
    const save=()=>{prune();for(const r of records){
      if(!state.records.has(r.id)&&!state.outgoing.has(r.id)){
        if(!r.replayOnly)state.records.set(r.id,r);if(runtime.env==='prod')state.outgoing.set(r.id,r);
      }
      if(barrier&&state.outgoing.has(r.id))barrier.pending.set(r.id,true);
    }void flush();};
    if(runtime.wallet?.deliver)runtime.wallet.deliver(save);else save();
  }
  function record(table,results,extra={}) {
    const replayOnly=Boolean(table.mtt||Number(table.roomType)===101);
    if(replayOnly&&table.gameId!=='holdem')return;
    const hand=table.hand,participants=hand?.statsPlayers || hand?.participants || hand?.players || table.members || [];
    const ownMember=uid=>{const p=participants.find(p=>Number(p.uid)===uid);return {p,member:p?.member||p||table.members?.find(m=>Number(m.uid)===uid)};};
    const records=[];
    for(const result of results){
      const uid=Number(result.uid),{p,member}=ownMember(uid);
      if(!Number.isSafeInteger(uid)||uid<=0||uid>=90000000||member?.bot||!isScore(result.score))continue;
      const session=sessionFor(table,uid,member),effectiveBet=Number(result.xiaZhuData ?? result.bet ?? member?.totalBet ?? 0);
      if(!isScore(effectiveBet)||effectiveBet<0)continue;
      if(table.kind==='hundred'&&effectiveBet===0&&result.score===0&&!result.banker)continue;
      const players=results.filter(r=>Number(r.uid)>0).map(r=>{const owner=ownMember(Number(r.uid));const {walletAmount,wallet,balance,...publicResult}=structuredClone(r);return {
        ...publicResult,userName:r.userName||r.name||owner.member?.name||String(r.uid),userIcon:r.userIcon||r.icon||owner.member?.icon||'',
        ...(Number(r.uid)===uid && Array.isArray(owner.p?.hole||owner.member?.hole)?{handPais:(owner.p?.hole||owner.member.hole).slice()}:{}),
        operateList:structuredClone(r.operateList||[]),userInfo:{uid:Number(r.uid),name:r.userName||r.name||owner.member?.name||String(r.uid),icon:r.userIcon||r.icon||owner.member?.icon||''}
      };});
      if([19,101].includes(Number(table.roomType))){
        for(const player of players){
          const source=ownMember(Number(player.uid)).member;
          const hole=Number(player.uid)===uid?(source?.hole||[]):(player.showCards?.length?player.showCards:[-1,-1]);
          player.handPais=hole.slice(0,2);
          player.commonPoker=(hand?.board||[]).slice();
          player.cardTypePokers=player.cardTypeInfo?.handCardList?.slice()||[];
          player.posName=source?.posName;
          player.operateList=(hand?.replayActions||[]).filter(a=>Number(a.uid)===Number(player.uid)).map(a=>{
            const {cards,...action}=a;return {...action};
          });
          player.operateList.push({gameState:3,operate:0,cards:hole.slice(0,2)});
          for(const [gameState,start,end]of [[5,0,3],[7,3,4],[9,4,5]])if(player.commonPoker.length>=end)
            player.operateList.push({gameState,operate:0,cards:player.commonPoker.slice(start,end)});
        }
      }
      const endedAt=table.kind==='slots'&&Number.isSafeInteger(extra.endedAt)&&extra.endedAt>0?extra.endedAt:Date.now(),inning=Number(extra.inning ?? table.currentInning ?? table.inning)||1;
      const recordRoomId=table.kind==='slots'&&Number.isSafeInteger(extra.originRoomId)&&extra.originRoomId>0?extra.originRoomId:table.roomId;
      const detail={...(extra.publicResult||{}),...(extra.details?.[uid]||{}),gameRoomId:recordRoomId,currInning:inning,
        ...([19,101].includes(Number(table.roomType))?{replay:captureHoldemReplay(table,hand,results,uid)}:{}),
        ...([19,25].includes(Number(table.roomType))?holdemUserCenterDetail(players,uid,hand?.board,Number(table.roomType)===25?3:2):{}),
        firstGameList:players,innerPlayerList:players.map(r=>({uid:r.uid,name:r.userName,icon:r.userIcon})),
        gameEndData:JSON.stringify({playerList:players,resultList:players}),currentInningJoin:true,
        reportMsg:{currentInningJoin:true,innerReport:false,reportFree:0,playerList:[]}};
      const native=captureNativeHistory(table,hand,results,players,uid,extra.publicResult);
      if(native)detail.nativeHistory=native;
      const id=table.kind==='slots'?[table.agentId,table.gameId,extra.key,uid].join(':'):[table.agentId,table.gameId,table.roomId,table.userCenterCreatedAt,inning,uid].join(':');
      const r={id,
        userId:uid,agentId:Number(table.agentId)||0,currency:session?.currency||table.mtt?.config?.currency||'CNY',gameId:table.gameId,roomType:Number(table.roomType),
        roomId:Number(recordRoomId),inning,endedAt,playMode:Number(table.playMode)||0,privateRoom:table.cfg?.private_room===true||Number(table.cfg?.private_room)===1,
        effectiveBet,net:result.score,name:session?.name||member?.name||String(uid),
        room:{ante:Number(table.ante)||0,smallBlind:Number(table.smallBlind)||0,bigBlind:Number(table.bigBlind)||0,initialBet:Number(table.initialBet)||0,
          createdAt:table.createdAt||table.userCenterCreatedAt,seeCardNo:table.roomRules?.seeCardNo,maxPeople:table.roomRules?.maxPeople||table.config?.maxPeople,
          maxBet:table.roomRules?.maxBet,forceShowCard:table.forceShowCard,
          ...(table.roomFeatures?{maxBottomPool:table.roomFeatures.maxPot,totalTakeIn:[...table.roomFeatures.players.values()].reduce((n,p)=>n+p.totalPoint,0),
            roomResults:[...table.roomFeatures.players.values()].map(p=>({uid:p.uid,score:p.winLostScore,takeIn:p.totalPoint,totalInningNum:p.totalHands,userInfo:p.userInfo}))}:{})},
        takeIn:table.roomFeatures?.players?.get(uid)?.totalPoint,
        players:players.map(p=>({uid:p.uid,score:p.score,userInfo:p.userInfo})),detail};
      const task=[...(table.smartTasks?.values()||[])].find(t=>t.userId===uid&&t.activeAttempt&&t.activeAttempt.inning===inning);
      if(task)r.smartTask={taskId:task.taskId,attemptId:task.activeAttempt.attemptId,inning};
      const balance=result.walletAmount ?? (session&&!result.banker?Number(session.wallet)+(table.kind==='normal'&&!member?.[carryKey]?Number(member?.point)||0:0):undefined);if(!replayOnly&&isScore(balance))r.balance=balance;
      if(replayOnly)r.replayOnly=true;
      records.push(r);
    }
    const barrier=replayOnly&&runtime.env==='prod'?table[tournamentReportsKey]:null;
    if(barrier){
      const expected=new Set(participants.filter(p=>Number.isSafeInteger(Number(p.uid))&&Number(p.uid)>0&&Number(p.uid)<90000000
        &&!(p.member||p).bot).map(p=>Number(p.uid)));
      if(!expected.size||records.length!==expected.size||new Set(records.map(r=>r.userId)).size!==records.length||records.some(r=>!expected.has(r.userId)))
        throw new Error('比赛已结束手牌的回放名单不完整');
      barrier.capturedInning=Math.max(barrier.capturedInning,Number(table.currentInning)||0);
      for(const r of records)if(!barrier.pending.has(r.id))barrier.pending.set(r.id,false);
      delete barrier.error;
    }
    runtime.wallet?.stageFinalReports?.(table,records);
    remember(records,barrier);
  }
  function attach(table){
    if(!Number.isFinite(table.userCenterCreatedAt))Object.defineProperty(table,'userCenterCreatedAt',{value:table.createdAt||Date.now(),configurable:true});
    if(runtime.env==='prod'&&(table.mtt||Number(table.roomType)===101)){
      // These are acknowledgements for already completed display records, not
      // financial intents. Keep them on the resident table across hot reload.
      const barrier=table[tournamentReportsKey]||={pending:new Map(),capturedInning:Number(table.mtt?.checkedInning)||0};
      Object.defineProperty(table,'userCenterReportsReady',{value:()=>{
        // Also observe acknowledgements from a write started by an older hot
        // module. A completed attempt removes its batch even if ES failed.
        for(const [id,queued]of barrier.pending)if(queued&&!state.outgoing.has(id))barrier.pending.delete(id);
        return !barrier.error&&!barrier.pending.size&&barrier.capturedInning>=Math.max(Number(table.mtt?.checkedInning)||0,Number(table.roomFeatures?.settledInning)||0);
      },configurable:true});
    }
    Object.defineProperty(table,'recordUserCenter',{value:(results,extra)=>{try{record(table,results,extra);}catch(error){
      const barrier=table[tournamentReportsKey];if(barrier)barrier.error=true;
      runtime.log.error('user-center record projection failed',error.message);
    }},configurable:true});return table;
  }
  state.originalSetTable ||= runtime.registry.setTable.bind(runtime.registry);
  runtime.registry.setTable=(...args)=>attach(state.originalSetTable(...args));
  for(const table of runtime.registry.tables.values())attach(table);
  // Adopt original queued records when this protection is first hot-loaded.
  // Do not attach an older incarnation's room records to a newly created table.
  for(const r of state.outgoing.values())if(r.replayOnly){
    const table=runtime.registry.getTable(r.roomId,r.agentId,r.gameId),barrier=table?.[tournamentReportsKey];
    if(barrier&&(!r.room?.createdAt||Number(r.room.createdAt)===Number(table.userCenterCreatedAt)))barrier.pending.set(r.id,true);
  }
  return {flush,query(query){
    prune();const records=[...state.records.values()].filter(r=>r.userId===Number(query.userId)&&r.agentId===Number(query.agentId));
    const key=r=>[r.roomType,r.roomId,r.detail?.serialFull||r.inning,r.userId].join(':');const seen=new Map(records.map((r,i)=>[key(r),i]));
    for(const r of legacyRecords?.(runtime,query)||[]){const index=seen.get(key(r));
      if(index===undefined){seen.set(key(r),records.length);records.push(r);}
      else if(Number(r.roomType)===19&&!records[index].detail?.ownCards){
        records[index]={...records[index],detail:{...records[index].detail,...r.detail}};
      }
    }
    return {records};
  },project:projectUserCenter};
}
