// Manager BlindItem types: 1=play, 2=manual-resume pause point, 3=timed rest.
// Validate once on both sides of the signed control boundary.
export function normalizeTournamentLevels(input){
  if(!Array.isArray(input)||!input.length||input.length>512)throw new Error('Invalid tournament blind plan');
  let total=0;
  const levels=input.map((source,index)=>{
    const level={...source,type:Number(source.type??1)};
    if(![1,2,3].includes(level.type))throw new Error('Unsupported tournament blind level type');
    for(const key of ['min','max','bet','interval']){
      level[key]=Number(level[key]??0);
      if(!Number.isSafeInteger(level[key])||level[key]<0)throw new Error('Invalid tournament blind amount or duration');
    }
    if(level.level!=null&&(!Number.isSafeInteger(Number(level.level))||Number(level.level)<=0))throw new Error('Invalid tournament blind level number');
    if(level.type===1&&(level.min<=0||level.max<level.min))throw new Error('Invalid tournament blinds');
    // A pause point is an event, without a scheduled duration. Resume moves
    // directly to the following playing level; no hidden countdown is started.
    if(level.type===2)level.interval=0;
    if(level.type!==2&&(index<input.length-1||level.type===3)&&level.interval<=0)throw new Error('A timed level requires a positive duration');
    if(level.type===2&&Number(input[index+1]?.type??1)!==1)throw new Error('A pause point must be followed by a playing level');
    total+=level.interval*1000;if(!Number.isSafeInteger(total))throw new Error('Tournament duration exceeds the safe range');
    return level;
  });
  if(levels[0].type!==1||levels.at(-1).type!==1)throw new Error('Tournament must begin and end with a playing level');
  return levels;
}

export function blindAt(config,at=Date.now(),clock={}){
  if(clock.pauseAt!=null)at=Math.min(at,clock.pauseAt);
  const levels=config.levels;
  let index=0,deadline=Number(config.startedAt)+Number(clock.delayMs||0);
  while(index<levels.length-1){
    const next=deadline+levels[index].interval*1000;
    if(at<next){deadline=next;break;}
    deadline=next;index++;
  }
  if(clock.autoPauseIndex!=null)index=clock.autoPauseIndex;
  const resting=levels[index].type===3;
  let playIndex=index;while(playIndex>0&&Number(levels[playIndex].type??1)!==1)playIndex--;
  let nextIndex=index+1;while(nextIndex<levels.length&&Number(levels[nextIndex].type??1)!==1)nextIndex++;
  const level=levels[playIndex],next=levels[nextIndex]||level;
  return {index,smallBlind:level.min,bigBlind:level.max,ante:level.bet,
    nextSmallBlind:next.min,nextBigBlind:next.max,nextAnte:next.bet,
    currentBlindLv:Number(level.level??playIndex+1),
    nextUpBlindTime:index===levels.length-1?0:Math.max(0,Math.ceil((deadline-at)/1000)),
    nextBlindAt:index===levels.length-1?0:deadline,
    isStopIncrBlind:index===levels.length-1,resting,automaticPause:clock.autoPauseIndex!=null};
}

// Every table shares one resident clock. The next rest cannot be skipped by a
// long hand or an event-loop delay, and begins only after all result animations.
export function updateTournamentClock(match,at=Date.now()){
  const clock=match.clock||={delayMs:0,completedRestIndex:-1};
  for(const table of match.tables)table.mtt.clock=clock;
  if(match.finished)return clock;
  if(clock.pauseRequested){
    if(clock.pauseAt==null&&match.tables.every(t=>t.mtt.closed||!t.hand&&t.phase!=='playing'&&at>=t.startAt)){
      clock.pauseAt=at;
      if(clock.autoPauseIndex!=null&&Number.isSafeInteger(clock.autoBoundaryAt))clock.delayMs+=at-clock.autoBoundaryAt;
    }
    if(clock.pauseAt!=null)return clock;
  }
  if(clock.restUntil!=null){
    if(at<clock.restUntil)return clock;
    clock.completedRestIndex=clock.waitingIndex;delete clock.restUntil;delete clock.waitingIndex;
  }
  let scheduled=Number(match.config.startedAt)+clock.delayMs;
  for(const [index,level] of match.config.levels.entries()){
    if(level.type===2&&index>Number(clock.completedPauseIndex??-1)&&at>=scheduled){
      clock.autoPauseIndex=index;clock.autoBoundaryAt=scheduled;clock.waitingIndex=index;clock.pauseRequested=true;
      if(match.tables.every(t=>t.mtt.closed||!t.hand&&t.phase!=='playing'&&at>=t.startAt)){
        clock.pauseAt=at;clock.delayMs+=at-scheduled;
      }
      break;
    }
    if(level.type===3&&index>clock.completedRestIndex&&at>=scheduled){
      clock.waitingIndex=index;
      if(match.tables.every(t=>t.mtt.closed||!t.hand&&t.phase!=='playing'&&at>=t.startAt)){
        clock.delayMs+=at-scheduled;clock.restUntil=at+level.interval*1000;
        for(const table of match.tables)if(!table.mtt.closed)table.mtt.paused=true;
      }
      break;
    }
    scheduled+=level.interval*1000;
  }
  return clock;
}

export function resumeTournamentClock(clock,at=Date.now()){
  if(clock.autoPauseIndex!=null&&clock.pauseAt==null)throw new Error('自动暂停点仍在等待当前手牌和动画结束');
  if(clock.pauseAt!=null){
    const duration=Math.max(0,at-clock.pauseAt);
    clock.delayMs=(clock.delayMs||0)+duration;clock.registrationDelayMs=(clock.registrationDelayMs||0)+duration;
    if(clock.restUntil!=null)clock.restUntil+=duration;
  }
  if(clock.autoPauseIndex!=null){
    clock.completedPauseIndex=clock.autoPauseIndex;
    delete clock.autoPauseIndex;delete clock.autoBoundaryAt;delete clock.waitingIndex;
  }
  delete clock.pauseAt;clock.pauseRequested=false;
  return clock;
}

export const tournamentRestSeconds=(clock,at=Date.now())=>clock?.restUntil==null?0:Math.max(0,Math.ceil((clock.restUntil-Math.min(at,clock.pauseAt??at))/1000));
