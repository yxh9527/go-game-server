import {randomInt} from 'node:crypto';
import {rel} from '../rel.js';
const version=new URL(import.meta.url).searchParams.get('v')||'0';
const {userInfoOf}=await rel(import.meta.url,'./member.js',version);
const {playerPanelStatistics,playerPanelWindows}=await rel(import.meta.url,'../../../shared/player-panel.js',version);
const {roomPlayerPanelRecords,playerPanelHandRow,panelRoomNames}=await rel(import.meta.url,'./player-panel-records.js',version);
const {queryHistory}=await rel(import.meta.url,'../../../shared/history-query.js',version);
const error=(status,message)=>Object.assign(new Error(message),{status});
const integer=(value,label)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw error(400,'Invalid '+label);return n;};
const seatRoomTypes=new Set([19,24,25,26,27,28,30,31,32]);

export async function createPlayerPanel(runtime){
  const dev=runtime.env!=='prod',gateway=runtime.gateway||runtime.rpc?.gateway;
  const local=dev?await rel(import.meta.url,'../../../cache/game-server/player-panel.js',version):null;
  if(dev&&!runtime.playerPanelLocalNotes){
    const {createMemoryPlayerNotes}=await rel(import.meta.url,'../../../cache/game-server/player-notes.js',version);
    runtime.playerPanelLocalNotes=createMemoryPlayerNotes();
  }
  const scope=(session,targetId)=>({agentId:Number(session.agentId),userId:Number(session.userId),targetId:Number(targetId),currency:session.currency||'CNY'});
  const notes={
    get:(session,targetId)=>dev?runtime.playerPanelLocalNotes.get(scope(session,targetId)):gateway.playerPanel('noteGet',scope(session,targetId)),
    set:(session,targetId,patch)=>dev?runtime.playerPanelLocalNotes.set(scope(session,targetId),patch):gateway.playerPanel('noteSet',{...scope(session,targetId),patch}),
  };
  function target(table,targetId){
    const uid=integer(targetId,'target player');
    const member=[...(table.members||[]),...(table.observers||[]),...(table.hand?.statsPlayers||[])].map(p=>p.member||p).find(p=>Number(p.uid)===uid);
    const archived=table.roomFeatures?.players?.get(uid);
    if(!member&&!archived)throw error(404,'玩家不在当前房间');
    return member||{uid,name:archived.userInfo?.name,icon:archived.userInfo?.icon};
  }
  function check(session,table){
    if(!session||session.authenticated===false||session.superseded||session.inRoom!==true||Number(session.agentId)!==Number(table?.agentId)
      ||Number(session.roomId)!==Number(table?.roomId)||!seatRoomTypes.has(Number(table?.roomType))
      ||session.gameId&&table.gameId&&session.gameId!==table.gameId)throw error(403,'只能查询当前游戏房间的玩家');
  }
  function robot(table,member){
    const bots=table.playerPanelBots ||= new Map();
    if(!bots.has(Number(member.uid))){
      const join=randomInt(18,57),raise=randomInt(5,Math.min(join,33)+1);
      bots.set(Number(member.uid),{totalHands:randomInt(120,3001),flipManualBetPercent:raise,joinPercent:join,tableJoinPercent:randomInt(12,66),
        todayScore:randomInt(-50000,50001),oneWeekScore:randomInt(-150000,150001),userFillingRate:{flip3BetRate:randomInt(2,14),flip3BetNum:randomInt(2,65),flip4BetRate:randomInt(0,7),flip4BetNum:randomInt(0,20)}});
    }
    const stats=bots.get(Number(member.uid));
    if(!stats.todayScore)stats.todayScore=(randomInt(0,2)?1:-1)*randomInt(100,50001);
    if(!stats.oneWeekScore)stats.oneWeekScore=(randomInt(0,2)?1:-1)*randomInt(500,150001);
    for(const field of ['flip4BetRate','flip4BetNum'])if(!stats.userFillingRate[field])stats.userFillingRate[field]=randomInt(1,field==='flip4BetRate'?8:21);
    stats.tableMateRateList ||= [];
    for(const peer of table.members||[]){
      if(Number(peer.uid)===Number(member.uid)||stats.tableMateRateList.some(p=>p.uid===Number(peer.uid)))continue;
      const info=userInfoOf(peer);
      stats.tableMateRateList.push({uid:Number(peer.uid),nickName:info.name,rate:randomInt(1,36),
        flip3BetRate:randomInt(3,18),flip3BetNum:randomInt(3,70),flip4BetRate:randomInt(1,8),flip4BetNum:randomInt(1,25),
        postFlop3BetRate:randomInt(2,17),postFlop3BetNum:randomInt(2,60)});
    }
    stats.tableMateRateList.sort((a,b)=>b.rate-a.rate||a.uid-b.uid);
    return stats;
  }
  async function data(session,table,uid){
    if(dev)return {records:local.localPlayerPanelRecords(runtime,{agentId:session.agentId,targetId:uid,currency:session.currency||'CNY',roomType:table.roomType}),complete:true};
    if(Number(table.roomType)!==19){
      const window=playerPanelWindows(),query={userId:uid,agentId:session.agentId,currency:session.currency||'CNY',kind:'hands',roomType:table.roomType,
        roomId:0,inning:0,page:1,size:1,endTime:window.now,sortDesc:true};
      const [lifetime,today,week,seven]=await Promise.all([gateway.playerPanel('read',{...scope(session,uid),roomId:table.roomId,roomType:Number(table.roomType)}),
        ...[window.today,window.week,window.sevenDays].map(startTime=>queryHistory(runtime,{...query,startTime},{rollingEnd:true}))]);
      const totals=lifetime?.statistics;
      if(!Number.isSafeInteger(totals?.totalHands)||totals.totalHands<0)throw error(503,'玩家累计手数数据源暂不可用');
      const effective={};
      if(totals.effectiveBetHands!==undefined||totals.effectiveBetHandPercent!==undefined){
        const count=totals.effectiveBetHands,percent=totals.effectiveBetHandPercent;
        const expected=totals.totalHands?Math.round(count/totals.totalHands*10000)/100:0;
        if(!Number.isSafeInteger(count)||count<0||count>totals.totalHands||!Number.isFinite(percent)||percent<0||percent>100||Math.abs(percent-expected)>0.000001)
          throw error(503,'玩家有效下注手数数据源暂不可用');
        Object.assign(effective,{effectiveBetHands:count,effectiveBetHandPercent:percent});
      }
      if(totals.netWinHands!==undefined||totals.winPercent!==undefined){
        const count=totals.netWinHands,percent=totals.winPercent;
        const expected=totals.totalHands?Math.round(count/totals.totalHands*10000)/100:0;
        if(!Number.isSafeInteger(count)||count<0||count>totals.totalHands||!Number.isFinite(percent)||percent<0||percent>100||Math.abs(percent-expected)>0.000001)
          throw error(503,'玩家净盈利局数数据源暂不可用');
        Object.assign(effective,{netWinHands:count,winPercent:percent});
      }
      if([24,25,26,27,28,30,31,32].includes(Number(table.roomType))&&totals.behaviorHands!==undefined){
        const {totalHands:total,behaviorHands:known,voluntaryHands:voluntary,raisedHands:raised,tableHands:tableTotal,tableBehaviorHands:tableKnown,tableVoluntaryHands:tableVoluntary}=totals;
        if(![known,voluntary,raised,tableTotal,tableKnown,tableVoluntary].every(Number.isSafeInteger)||known<0||known>total||voluntary<0||voluntary>known||raised<0||raised>voluntary||tableTotal<0||tableTotal>total||tableKnown<0||tableKnown>Math.min(tableTotal,known)||tableVoluntary<0||tableVoluntary>Math.min(tableKnown,voluntary))throw error(503,'玩家行为统计数据源暂不可用');
        const ratio=(count,n)=>n?Math.round(count/n*10000)/100:0;
        Object.assign(effective,{behaviorHands:known,voluntaryHands:voluntary,raisedHands:raised,
          joinPercent:[25,31].includes(Number(table.roomType))&&known===total?ratio(voluntary,total):'--',flipManualBetPercent:Number(table.roomType)===25&&known===total?ratio(raised,total):'--',tableJoinPercent:[25,31].includes(Number(table.roomType))&&tableKnown===tableTotal?ratio(tableVoluntary,tableTotal):'--'});
        if(Number(table.roomType)===31){
          if(raised!==0||![totals.doubleHands,totals.splitHands,totals.insuranceBuyHands].every(count=>Number.isSafeInteger(count)&&count>=0&&count<=known))throw error(503,'二十一点动作统计数据源暂不可用');
          if(known===total)Object.assign(effective,{manualBetHands:voluntary,manualBetPercent:ratio(voluntary,total),doubleHands:totals.doubleHands,doublePercent:ratio(totals.doubleHands,total),splitHands:totals.splitHands,splitPercent:ratio(totals.splitHands,total),insuranceBuyHands:totals.insuranceBuyHands,insuranceBuyPercent:ratio(totals.insuranceBuyHands,total)});
        }
        if(Number(table.roomType)===27){
          const submitted=totals.clientArrangementHands,extended=totals.extendedArrangementHands;
          if(voluntary!==0||raised!==0||![submitted,extended].every(count=>Number.isSafeInteger(count)&&count>=0&&count<=known))throw error(503,'十三水理牌统计数据源暂不可用');
          if(known===total)Object.assign(effective,{clientArrangementHands:submitted,clientArrangementPercent:ratio(submitted,total),serverArrangementHands:total-submitted,serverArrangementPercent:ratio(total-submitted,total),extendedArrangementHands:extended,extendedArrangementPercent:ratio(extended,total)});
        }
        if([26,28,30].includes(Number(table.roomType))){
          if(voluntary!==0||raised!==0||![totals.clientDiscardHands,totals.serverDiscardHands].every(count=>Number.isSafeInteger(count)&&count>=0&&count<=known))throw error(503,'麻将出牌来源统计数据源暂不可用');
          if(known===total)for(const key of ['clientDiscard','serverDiscard'])Object.assign(effective,{[key+'Hands']:totals[key+'Hands'],[key+'Percent']:ratio(totals[key+'Hands'],total)});
        }
        if([24,32].includes(Number(table.roomType))){
          const opportunities=totals.betOpportunityHands,above=totals.aboveMinimumBetHands,grab=totals.manualGrabHands,positive=totals.positiveGrabHands;
          if(raised!==0||![opportunities,above,grab,positive].every(Number.isSafeInteger)||opportunities<voluntary||opportunities>known||above<0||above>voluntary||grab<0||grab>known||positive<0||positive>grab||Number(table.roomType)===32&&(opportunities!==known||grab!==0||positive!==0))throw error(503,'座位游戏动作统计数据源暂不可用');
          if(known===total){Object.assign(effective,{betOpportunityHands:opportunities,manualBetHands:voluntary,manualBetPercent:ratio(voluntary,opportunities),aboveMinimumBetHands:above,aboveMinimumBetPercent:ratio(above,opportunities)});
            if(Number(table.roomType)===24)Object.assign(effective,{manualGrabHands:grab,manualGrabPercent:ratio(grab,total),positiveGrabHands:positive,positiveGrabPercent:ratio(positive,total)});}
        }
      }
      return {records:[],complete:false,statistics:{totalHands:totals.totalHands,...effective,todayScore:today.totalScore,oneWeekScore:week.totalScore,oneWeekHands:seven.total,
        flipManualBetPercent:effective.flipManualBetPercent??'--',joinPercent:effective.joinPercent??'--',tableJoinPercent:effective.tableJoinPercent??'--'}};
    }
    const result=await gateway.playerPanel('read',{...scope(session,uid),roomId:table.roomId});
    if(!result||!Array.isArray(result.records))throw error(503,'玩家统计数据源暂不可用');return result;
  }
  return {
    syncRoomBots(table){if(seatRoomTypes.has(Number(table.roomType)))for(const member of table.members||[])if(member.bot||Number(member.uid)>=90000000)robot(table,member);},
    async profile(session,table,targetId){
      check(session,table);const member=target(table,targetId),uid=Number(member.uid),info=userInfoOf(member),note=await notes.get(session,uid);
      (session.playerPanelNotes ||= new Map()).set(uid,note);
      const bot=Boolean(member.bot)||uid>=90000000;
      const source=bot?{records:roomPlayerPanelRecords(table,uid),complete:true}:await data(session,table,uid);
      const stats=playerPanelStatistics(source.records,{targetId:uid,roomId:table.roomId,roomType:table.roomType,complete:source.complete!==false});
      const recentRecordCount=bot?source.records.length:Number(source.statistics?.oneWeekHands??stats.oneWeekHands);
      return {playerId:uid,name:info.name,imageUrl:info.icon,regionCode:info.regionCode,...stats,...source.statistics,
        ...(bot?{...robot(table,member),oneWeekHands:recentRecordCount,isRobot:true}:{}),
        recentRecordCount,recentRecordsAvailable:recentRecordCount>0,recentRecordScope:bot?'room':'seven-days',...note};
    },
    async remark(session,table,payload){
      check(session,table);const member=target(table,payload.targetId),patch={};
      for(const [input,field,max]of [['remark','remarkName',32],['remarkMessage','remarkMessage',256]])if(Object.hasOwn(payload,input)){
        if(typeof payload[input]!=='string'||[...payload[input]].length>max||[...payload[input]].some(c=>c.charCodeAt(0)<32||c===';'))throw error(400,'备注格式或长度无效');
        patch[field]=payload[input].trim();
      }
      if(Object.hasOwn(payload,'mark')){const mark=Number(payload.mark);if(!Number.isInteger(mark)||mark<0||mark>6)throw error(400,'无效玩家标签');patch.mark=mark;}
      if(!Object.keys(patch).length)throw error(400,'备注内容为空');
      const saved=await notes.set(session,Number(member.uid),patch);
      (session.playerPanelNotes ||= new Map()).set(Number(member.uid),saved);
      return {targetUid:Number(member.uid),...saved};
    },
    async quota(session,table){check(session,table);return dev?runtime.playerPanelLocalNotes.quota(scope(session,session.userId))
      :(await gateway.playerPanel('quota',scope(session,session.userId))).remaining;},
    async gift(session,table,payload){
      check(session,table);
      if(Number(payload.type)!==5)throw error(501,'高级道具暂未开放');
      if(payload.sendUid!=null&&Number(payload.sendUid)!==Number(session.userId))throw error(403,'不能冒用其他玩家赠送道具');
      const sender=(table.members||[]).find(p=>Number(p.uid)===Number(session.userId));
      const targetId=Number(payload.content?.toId),recipient=(table.members||[]).find(p=>Number(p.uid)===targetId);
      if(!sender||!recipient||targetId===Number(session.userId))throw error(403,'只有在座玩家可向本桌其他在座玩家赠送道具');
      if(table.cfg?.ban_emoji===true||Number(table.cfg?.ban_emoji)===1||table.banEmoji===true||Number(table.banEmoji)===1)throw error(403,'当前房间禁止道具');
      const propId=Number(payload.content?.propId);
      if(!Number.isInteger(propId)||propId<0||propId>14)throw error(400,'无效普通道具');
      const remaining=dev?await runtime.playerPanelLocalNotes.consume(scope(session,targetId))
        :(await gateway.playerPanel('gift',{...scope(session,targetId),propId})).remaining;
      return {remaining,message:{sendUid:Number(session.userId),type:5,content:{toId:targetId,propId}}};
    },
    async records(session,table,targetId,page=1,size=10){
      check(session,table);const member=target(table,targetId),bot=Boolean(member.bot)||Number(targetId)>=90000000;
      if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(size)||size<1||size>100||(page-1)*size>=10000)throw error(400,'无效分页');
      const window=playerPanelWindows();
      const source=bot?{records:roomPlayerPanelRecords(table,targetId)}:dev?await data(session,table,Number(targetId))
        :Number(table.roomType)===19?await gateway.playerPanel('records',{
          ...scope(session,Number(targetId)),roomId:table.roomId,page,size,
        }):await queryHistory(runtime,{userId:Number(targetId),agentId:session.agentId,currency:session.currency||'CNY',kind:'hands',
          roomType:Number(table.roomType),roomId:0,inning:0,page,size,startTime:window.sevenDays,endTime:window.now,sortDesc:true},{rollingEnd:true});
      const records=source.records.filter(r=>bot||r.endedAt>=window.sevenDays&&r.endedAt<=window.now)
        .map(r=>({...r,roomType:r.roomType||table.roomType,players:r.detail?.firstGameList||r.players||[]}))
        .sort((a,b)=>b.endedAt-a.endedAt||b.inning-a.inning);
      return {infoList:(source.paged?records:records.slice((page-1)*size,page*size)).map(r=>playerPanelHandRow(r,session.userId)),totalInning:source.total??records.length,
        ownJoinInning:source.total??records.length,ownScore:source.score??source.totalScore??records.reduce((sum,r)=>sum+r.net,0),
        recentRecordScope:bot?'room':'seven-days',roomTypeName:panelRoomNames[Number(table.roomType)],
        blind:JSON.stringify({ante:table.ante||0,smallBlind:table.smallBlind||0,bigBlind:table.bigBlind||0,initialBet:table.initialBet||0})};
    },
  };
}
