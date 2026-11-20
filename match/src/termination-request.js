// The caller supplies the authenticated admin scope, never a client-selected
// actor. Keep access credentials out of durable operational audit records.
export function terminationRequest(scope,reason){
  if(!scope||!Number.isSafeInteger(scope.agentId)||scope.agentId<=0||!['agent','platform','dev'].includes(scope.kind))
    throw Object.assign(new Error('缺少有效的管理权限范围'),{status:403});
  if(typeof reason!=='string'||!reason.trim()||reason.trim().length>300)
    throw Object.assign(new Error('请填写 1 至 300 字的终止原因'),{status:400});
  return {reason:reason.trim(),actor:{kind:scope.kind,agentId:scope.agentId}};
}
