import { rel } from "./rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { requestRoomPool } = await rel(import.meta.url, './room-pool.js', version);

// Reuse the authenticated internal query transport on the existing listener.
// This must never participate in player login ownership or room lifecycle.
export async function requestFairCode(runtime, params) {
  if (runtime.env !== "dev") return Promise.resolve({
    msgCode: 501, errMsg: "正式环境公正码数据源尚未接入", data: null,
  });
  const userId = Number(params.userId);
  const gameRoomId = Number(params.gameRoomId);
  const currentInning = Number(params.currentInning);
  const token = String(params.token || params.userToken || "");
  if (![userId, gameRoomId, currentInning].every((value) => Number.isSafeInteger(value) && value > 0) || !token) {
    return Promise.resolve({ msgCode: 400, errMsg: "公正码请求缺少有效的用户、房间、局号或登录凭证", data: null });
  }
  try {
    // Read-only internal query: never send player login 1105 or reserve a
    // primary/secondary session for the temporary query connection.
    const data=await requestRoomPool(runtime,{userId,token},'fair-code',{
      gameRoomId,currentInning,...(params.roomType!=null?{roomType:Number(params.roomType)}:{}),
    });
    return {msgCode:200,errMsg:null,data};
  } catch(error) {
    const code=[400,401,403,404].includes(error.code)?error.code:503;
    return {msgCode:code,errMsg:error.message,data:null};
  }
}
