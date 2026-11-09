// A spectator of an uncontested, no-show hand has no showdown stage. The
// original model still reads that optional stage while building its summary.
// Keep the optional stage absent and use only the already-public board.
export function adaptHoldemReplayResponse(source) {
  const moduleStart=source.indexOf("'HoldemHistoryModel':[");
  if(moduleStart<0)return source;
  const start=source.indexOf("z['prototype']['onPushRecordDetail']=",moduleStart);
  const end=source.indexOf(",z['prototype']['checkToShowSendCards']=",start);
  if(start<moduleStart||end<start)return source;
  const method=source.slice(start,end);
  const adapted=method.replace("'cardList':I['cardList']",
    "'cardList':I?I['cardList']:[]['concat'](G['length']?G[0]['commonPokerList']||[]:[])");
  return source.slice(0,start)+adapted+source.slice(end);
}
