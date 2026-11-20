// Persistent payment ownership lives in data-center, behind the common facade.
// This adapter never keeps a local financial receipt or fabricates a success.
export function createMatchPayments(common){
  if(typeof common?.matchPayment!=='function')throw new Error('Tournament payment authority is not configured');
  async function invoke(operation,plan,includeService=false){
    try{return await common.matchPayment(operation,plan,includeService);}catch(error){
      if(Number(error.status)>=500){
        try{
          const state=await common.matchPayment('query',plan);
          if(operation==='charge'&&state.status==='charged')return state.receipt;
          if(operation==='refund'&&state.status==='refunded')return state.refund;
          if(operation==='award'&&state.status==='paid')return state.receipt;
        }catch{}
      }
      throw error;
    }
  }
  return Object.freeze({
    charge:plan=>invoke('charge',plan),
    refund:plan=>invoke('refund',plan,true),
    award:plan=>invoke('award',plan),
    query:plan=>common.matchPayment('query',plan),
  });
}
