// Native smart_net uses op=71. Even an empty market is an object, not [].
// No smart-task executor exists yet: never acknowledge a purchase/stop/delete.
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
