import {getGogameStorageClient} from '../../utils/gogameStorageGrpc.js';

export function createDataCenterStore(getClient=getGogameStorageClient) {
  const call=async(operation,payload={})=>(await getClient()).call(operation,payload);
  const store={};
  for(const operation of ['listRooms','listFinanceGames','listMatches','listTickets','listRates','listAwards','listBlinds','listMatchPlayers','listMatchRooms','listSchedules']){
    store[operation]=()=>call(operation);
  }
  for(const operation of ['getMatch','getAward'])store[operation]=id=>call(operation,{id:Number(id)});
  store.deleteBlinds=id=>call('deleteBlinds',{id:Number(id)});
  store.deleteMatch=id=>call('deleteMatch',{id:Number(id)});
  store.readMatch=id=>call('readMatch',{id:Number(id)});
  store.deleteTicket=id=>call('deleteTicket',{id:Number(id)});
  store.issueTickets=request=>call('issueTickets',request);
  for(const operation of ['insertMatch','insertTicket','upsertRate','insertAward','insertBlinds'])store[operation]=row=>call(operation,{row});
  for(const operation of ['updateMatch','updateTicket','updateAward','updateBlinds'])store[operation]=(id,patch)=>call(operation,{id:Number(id),patch});
  store.countUnusedTickets=userId=>call('countUnusedTickets',{userId:Number(userId)});
  store.saveSchedule=(id,row)=>call('saveSchedule',{id:Number(id)||0,row});
  store.ensureOccurrence=(schedule,slot,row)=>call('ensureOccurrence',{schedule,slot,row});
  store.withMatch=async(id,work)=>(await getClient()).withMatch(Number(id),work);
  return store;
}
