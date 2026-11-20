// Elimination order is worst place first: smaller opening stack, then smaller
// numeric UID. Every player receives a distinct place; awards are never split.
export function tournamentEliminationGroups(players){
  if(!Array.isArray(players)||players.length>5000)throw new Error('Invalid tournament elimination list');
  const seen=new Set(),groups=new Map();
  for(const player of players){
    if(!player||!Number.isSafeInteger(player.uid)||player.uid<=0||seen.has(player.uid)||player.point!==0
      ||!Number.isSafeInteger(player.openingPoint)||player.openingPoint<=0)throw new Error('Invalid settled tournament stack');
    seen.add(player.uid);
    const group=groups.get(player.openingPoint)||[];group.push(player);groups.set(player.openingPoint,group);
  }
  return [...groups].sort(([a],[b])=>a-b).map(([openingPoint,members])=>({openingPoint,players:members.slice().sort((a,b)=>a.uid-b.uid)}));
}

export const tournamentEliminationOrder=players=>tournamentEliminationGroups(players).flatMap(group=>group.players);

export function validateTournamentFinalRanks(players){
  if(!Array.isArray(players)||!players.length||players.length>5000)throw new Error('Invalid final tournament roster');
  const ids=new Set(),ranks=new Set();
  for(const player of players){
    const uid=player.userId??player.uid;
    if(!Number.isSafeInteger(uid)||uid<=0||ids.has(uid)||!Number.isSafeInteger(player.rank)||player.rank<1||player.rank>players.length||ranks.has(player.rank))
      throw new Error('Final tournament ranks must be unique and contiguous');
    ids.add(uid);ranks.add(player.rank);
  }
}
