import { rel } from '../rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {projectUserCenter,holdemUserCenterDetail}=await rel(import.meta.url,'../../../shared/user-center.js',version);
const carryKey=Symbol.for('gogame.cash.carry.member'),TTL=31*86400000;
const isScore=value=>Number.isSafeInteger(value);

export function installUserCenter(runtime,legacyRecords) {
  const state=runtime.userCenterState ||= {records:new Map(),outgoing:new Map(),writeTask:null};
  function prune(){const now=Date.now();for(const [id,r]of state.records)if(now-r.endedAt>TTL)state.records.delete(id);while(state.records.size>50000)state.records.delete(state.records.keys().next().value);}
  function sessionFor(table,uid,member){return member?.departureSession || member?.[carryKey]?.session
    || table.playerSessions?.get(uid) || [...runtime.registry.sessions.values()].find(s=>Number(s.userId)===uid&&Number(s.agentId)===Number(table.agentId));}
  async function flush(){
    if(runtime.env!=='prod'||!state.outgoing.size||state.writeTask)return state.writeTask;
    const gateway=runtime.gateway||runtime.rpc?.gateway;if(!gateway?.writeUserCenter)return;
    const batch=[...state.outgoing.values()].slice(0,100);
    const task=Promise.resolve().then(()=>gateway.writeUserCenter(batch)).then(()=>{for(const r of batch)state.outgoing.delete(r.id);})
      .catch(error=>runtime.log.error('user-center record write failed',error.message));
    state.writeTask=task;task.finally(()=>{if(state.writeTask===task)state.writeTask=null;});return task;
  }
  function remember(records){
    const save=()=>{prune();for(const r of records){if(state.records.has(r.id))continue;state.records.set(r.id,r);if(runtime.env==='prod')state.outgoing.set(r.id,r);}while(state.outgoing.size>50000)state.outgoing.delete(state.outgoing.keys().next().value);void flush();};
    if(runtime.wallet?.deliver)runtime.wallet.deliver(save);else save();
  }
  function record(table,results,extra={}) {
    if(table.mtt||Number(table.roomType)===101)return;
    const hand=table.hand,participants=hand?.statsPlayers || hand?.participants || hand?.players || table.members || [];
    const ownMember=uid=>{const p=participants.find(p=>Number(p.uid)===uid);return {p,member:p?.member||p||table.members?.find(m=>Number(m.uid)===uid)};};
    const records=[];
    for(const result of results){
      const uid=Number(result.uid),{p,member}=ownMember(uid);
      if(!Number.isSafeInteger(uid)||uid<=0||uid>=90000000||member?.bot||!isScore(result.score))continue;
      const session=sessionFor(table,uid,member),effectiveBet=Number(result.xiaZhuData ?? result.bet ?? member?.totalBet ?? 0);
      if(!isScore(effectiveBet)||effectiveBet<0)continue;
      if(table.kind==='hundred'&&effectiveBet===0&&result.score===0)continue;
      const players=results.filter(r=>Number(r.uid)>0).map(r=>{const owner=ownMember(Number(r.uid));const {walletAmount,wallet,balance,...publicResult}=structuredClone(r);return {
        ...publicResult,userName:r.userName||r.name||owner.member?.name||String(r.uid),userIcon:r.userIcon||r.icon||owner.member?.icon||'',
        ...(Number(r.uid)===uid && Array.isArray(owner.p?.hole||owner.member?.hole)?{handPais:(owner.p?.hole||owner.member.hole).slice()}:{}),
        operateList:structuredClone(r.operateList||[]),userInfo:{uid:Number(r.uid),name:r.userName||r.name||owner.member?.name||String(r.uid),icon:r.userIcon||r.icon||owner.member?.icon||''}
      };});
      if(Number(table.roomType)===19){
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
      const endedAt=Date.now(),inning=Number(extra.inning ?? table.currentInning ?? table.inning)||1;
      const detail={...(extra.publicResult||{}),...(extra.details?.[uid]||{}),gameRoomId:table.roomId,currInning:inning,
        ...([19,25].includes(Number(table.roomType))?holdemUserCenterDetail(players,uid,hand?.board,Number(table.roomType)===25?3:2):{}),
        firstGameList:players,innerPlayerList:players.map(r=>({uid:r.uid,name:r.userName,icon:r.userIcon})),
        gameEndData:JSON.stringify({playerList:players,resultList:players}),currentInningJoin:true,
        reportMsg:{currentInningJoin:true,innerReport:false,reportFree:0,playerList:[]}};
      const id=table.kind==='slots'?[table.agentId,table.gameId,extra.key,uid].join(':'):[table.agentId,table.gameId,table.roomId,table.userCenterCreatedAt,inning,uid].join(':');
      const r={id,
        userId:uid,agentId:Number(table.agentId)||0,currency:session?.currency||'CNY',gameId:table.gameId,roomType:Number(table.roomType),
        roomId:Number(table.roomId),inning,endedAt,playMode:Number(table.playMode)||0,privateRoom:table.cfg?.private_room===true||Number(table.cfg?.private_room)===1,
        effectiveBet,net:result.score,name:session?.name||member?.name||String(uid),
        room:{ante:Number(table.ante)||0,smallBlind:Number(table.smallBlind)||0,bigBlind:Number(table.bigBlind)||0,initialBet:Number(table.initialBet)||0,
          createdAt:table.createdAt||table.userCenterCreatedAt,seeCardNo:table.roomRules?.seeCardNo,maxPeople:table.roomRules?.maxPeople||table.config?.maxPeople,
          maxBet:table.roomRules?.maxBet,forceShowCard:table.forceShowCard,
          ...(table.roomFeatures?{maxBottomPool:table.roomFeatures.maxPot,totalTakeIn:[...table.roomFeatures.players.values()].reduce((n,p)=>n+p.totalPoint,0),
            roomResults:[...table.roomFeatures.players.values()].map(p=>({uid:p.uid,score:p.winLostScore,takeIn:p.totalPoint,totalInningNum:p.totalHands,userInfo:p.userInfo}))}:{})},
        takeIn:table.roomFeatures?.players?.get(uid)?.totalPoint,
        players:players.map(p=>({uid:p.uid,score:p.score,userInfo:p.userInfo})),detail};
      const balance=result.walletAmount ?? (session&&!result.banker?Number(session.wallet)+(table.kind==='normal'&&!member?.[carryKey]?Number(member?.point)||0:0):undefined);if(isScore(balance))r.balance=balance;
      records.push(r);
    }
    remember(records);
  }
  function attach(table){
    if(!Number.isFinite(table.userCenterCreatedAt))Object.defineProperty(table,'userCenterCreatedAt',{value:table.createdAt||Date.now(),configurable:true});
    Object.defineProperty(table,'recordUserCenter',{value:(results,extra)=>{try{record(table,results,extra);}catch(error){runtime.log.error('user-center record projection failed',error.message);}},configurable:true});return table;
  }
  state.originalSetTable ||= runtime.registry.setTable.bind(runtime.registry);
  runtime.registry.setTable=(...args)=>attach(state.originalSetTable(...args));
  for(const table of runtime.registry.tables.values())attach(table);
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
