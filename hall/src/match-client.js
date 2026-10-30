export async function matchRequest(runtime,params,action='snapshot') {
  const configured=runtime.config.match_server || (runtime.env==='dev'?'127.0.0.1:11040':'');
  if(!configured)throw Object.assign(new Error('比赛服务地址尚未配置'),{code:503});
  const base=/^https?:\/\//i.test(configured)?configured:'http://'+configured;
  const response=await fetch(new URL('/internal/v1/tournament',base),{
    method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(5000),
    body:JSON.stringify({action,matchId:Number(params.championshipsConfigId),userId:Number(params.userId),token:params.token||params.userToken}),
  });
  const body=await response.json();
  if(!response.ok||body.code!==0)throw Object.assign(new Error(body.msg||'比赛服务暂不可用'),{code:body.code||503});
  if (runtime.env === 'dev' && body.metadata) runtime.matchStore.replaceMetadata?.(body.metadata);
  for(const item of body.data||[]) runtime.matchStore.applyEnvelope({event:'match_snapshot',data:item});
  return body.data;
}
