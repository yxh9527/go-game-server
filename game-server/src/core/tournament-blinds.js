export function blindAt(config,at=Date.now()) {
  let index=0,deadline=Number(config.startedAt);
  while(index<config.levels.length-1){
    const next=deadline+config.levels[index].interval*1000;
    if(at<next){deadline=next;break;}
    deadline=next;index++;
  }
  const level=config.levels[index],next=config.levels[index+1]||level;
  return {index,smallBlind:level.min,bigBlind:level.max,ante:level.bet,
    nextSmallBlind:next.min,nextBigBlind:next.max,nextAnte:next.bet,
    currentBlindLv:index+1,nextUpBlindTime:index===config.levels.length-1?0:Math.max(0,Math.ceil((deadline-at)/1000)),
    isStopIncrBlind:index===config.levels.length-1};
}
