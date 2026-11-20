// One in-flight submission per existing form. This is a page interaction
// lock, not a financial idempotency record or a retry mechanism.
export function createAdminSubmissions(){
  const pending=new Map();
  return {
    submit(key,work){
      if(pending.has(key))return false;
      const token={};pending.set(key,token);
      const finish=()=>{if(pending.get(key)===token)pending.delete(key);};
      try{return Promise.resolve(work()).finally(finish);}catch(error){finish();return Promise.reject(error);}
    },
    stats(){return {pendingForms:pending.size};},
  };
}
