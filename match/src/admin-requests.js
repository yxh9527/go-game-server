// Shared by the real browser page and isolated tests. No credentials persist
// beyond the page, and mutation requests are never retried automatically.
export function createAdminRequests({identity,send=globalThis.fetch,timeoutMs=15000,onIdentityChange=()=>{}}){
  let current=identity(),version=0,closed=false;
  const reads=new Map();
  function stale(){return Object.assign(Error('管理身份或请求已变化，请重新读取。'),{staleAdminRequest:true});}
  function sync(){
    const next=identity();
    if(next.token!==current.token||next.agent!==current.agent){
      current=next;version++;
      for(const controller of reads.values())controller.abort();reads.clear();
      onIdentityChange();
    }
    return version;
  }
  function assertScope(expected){if(closed||sync()!==expected)throw stale();}
  async function request(url,method='GET',body){
    const scope=sync();if(closed)throw stale();
    const controller=new AbortController(),read=method==='GET';
    if(read){reads.get(url)?.abort();reads.set(url,controller);}
    const headers={'Content-Type':'application/json','X-Admin-Token':current.token};
    if(current.agent)headers['X-Agent-Id']=current.agent;
    const timer=setTimeout(()=>controller.abort(Object.assign(Error('请求超时，请刷新确认结果。'),{name:'TimeoutError'})),timeoutMs);
    const check=()=>{assertScope(scope);if(read&&reads.get(url)!==controller)throw stale();};
    try{
      const response=await send(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:controller.signal});
      check();const result=await response.json();check();
      if(!response.ok||result.code!==0)throw Error(result.msg||'请求失败');
      return result.data;
    }catch(error){
      check();throw error;
    }finally{
      clearTimeout(timer);if(read&&reads.get(url)===controller)reads.delete(url);
    }
  }
  return {request,sync,assertScope,stale,dispose(){closed=true;version++;for(const controller of reads.values())controller.abort();reads.clear();},stats(){return {pendingReads:reads.size};}};
}
