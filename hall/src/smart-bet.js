// Native smart_net uses op=71. Even an empty market is an object, not [].
import {requestRoomPool} from './room-pool.js';
export async function smartBetRequest(runtime,params){
  try{
    const biz=JSON.parse(params.bizParam),roomType=Number(params.roomType),kind=Number(params.bizType);
    if(!biz||biz.roomType!==roomType||![58,59].includes(roomType)||![0,1].includes(kind))return smartBetResponse(params);
    // Native good-road cards assume their own strategy enums and numeric status.
    // Fixed tasks use the explicit configuration page, never masquerade as roads.
    if(biz.strategy!=='FIXED')return smartBetResponse(params);
    if(kind===0&&Number(biz.reqType)===0)return smartBetResponse(params);
    const action=kind===0?biz.taskId?'detail':'list':({1:'create',2:'stop',3:'delete'})[Number(biz.operateType)];
    if(!action)return {msgCode:400,errMsg:'未知固定投注操作',data:null};
    const data=await requestRoomPool(runtime,params,'smart-bet',{request:{...biz,roomType,action}});
    return {msgCode:200,errMsg:null,data};
  }catch(error){return {msgCode:error.code||400,errMsg:error.message,data:null}}
}
// Native good-road strategies remain unavailable. Fixed tasks are forwarded
// above; this fallback must never acknowledge their purchase/stop/delete.
export function smartBetResponse(params) {
  const fail = (msgCode, errMsg) => ({ msgCode, errMsg, data: null });
  let biz;
  try {
    biz = JSON.parse(params.bizParam);
  } catch {
    return fail(400, "智能投注请求参数无效");
  }
  if (!biz || typeof biz !== "object" || Array.isArray(biz)) {
    return fail(400, "智能投注请求参数无效");
  }
  const roomType = Number(params.roomType);
  if (!Number.isSafeInteger(roomType) || roomType <= 0 || biz.roomType !== roomType) {
    return fail(400, "智能投注游戏类型无效");
  }
  const bizType = Number(params.bizType);
  if (bizType === 1) return fail(501, "智能投注任务操作尚未开放");
  if (bizType !== 0) return fail(400, "智能投注业务类型无效");
  if (biz.reqType === 0 && biz.goodRoadType == null) {
    return { msgCode: 200, errMsg: null, data: {
      overview: { participantCount: 0, participantAmount: 0 },
      marketList: [],
    } };
  }
  if (biz.reqType === 1 && biz.taskId == null) {
    return { msgCode: 200, errMsg: null, data: { myTasks: [] } };
  }
  if (biz.reqType === 1) return fail(404, "智能投注任务不存在");
  return fail(501, "智能投注详情尚未开放");
}
