import {getGogameStorageClient} from '../../utils/gogameStorageGrpc.js';

export function createDataCenterStore(getClient=getGogameStorageClient) {
  const call=async(operation,payload={})=>(await getClient()).call(operation,payload);
  const store={};
  for(const operation of ['listRooms','listMatches','listTickets','listRates','listAwards','listBlinds','listMatchPlayers','listMatchRooms','listSchedules']){
    store[operation]=()=>call(operation);
  }
  for(const operation of ['getMatch','getAward'])store[operation]=id=>call(operation,{id:Number(id)});
  for(const operation of ['insertMatch','insertTicket','upsertRate','insertAward','insertBlinds'])store[operation]=row=>call(operation,{row});
  for(const operation of ['updateMatch','updateTicket','updateAward','updateBlinds'])store[operation]=(id,patch)=>call(operation,{id:Number(id),patch});
  store.countUnusedTickets=userId=>call('countUnusedTickets',{userId:Number(userId)});
  store.saveSchedule=(id,row)=>call('saveSchedule',{id:Number(id)||0,row});
  store.ensureOccurrence=(schedule,slot,row)=>call('ensureOccurrence',{schedule,slot,row});
  store.withMatch=async(id,work)=>(await getClient()).withMatch(Number(id),work);
  return store;
}
