import WebSocket from "ws";
import { encodeFrame, decodeFrame } from "../../game-server/src/codec.js";
import { rel } from "./rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { SEND, PUSH } = await rel(import.meta.url, "../../game-server/src/messages.js", version);

// Reuse the existing authenticated socket protocol; do not create a second
// public internal endpoint or change/restart the persistent HTTP listener.
export function requestFairCode(runtime, params) {
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
  const configured = String(runtime.config.game_server || "127.0.0.1:11041");
  const endpoint = new URL(/^[a-z]+:\/\//i.test(configured) ? configured : "ws://" + configured);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  return new Promise((resolve) => {
    const socket = new WebSocket(endpoint);
    let done = false;
    let requested = false;
    const finish = (response) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(response);
    };
    const unavailable = () => finish({ msgCode: 503, errMsg: "暂时无法查询公正码，请稍后再试", data: null });
    const timer = setTimeout(() => {
      unavailable();
      socket.terminate();
    }, 3000);
    socket.on("error", unavailable);
    socket.on("close", () => { if (!done) unavailable(); });
    socket.on("open", () => socket.send(encodeFrame(SEND.ROOM_LOGIN, { userId, userToken: token })));
    socket.on("message", (raw) => {
      let frame;
      try { frame = decodeFrame(raw); } catch { unavailable(); return; }
      if (frame?.msgid === PUSH.ROOM_LOGIN && !requested) {
        if (frame.payload?.opType !== 0) {
          finish({ msgCode: 401, errMsg: "登录凭证无效", data: null });
          return;
        }
        requested = true;
        socket.send(encodeFrame(SEND.SEND_BLOCKCHAIN_INFO, {
          gameRoomId, currentInning,
          ...(params.roomType != null ? { roomType: Number(params.roomType) } : {}),
        }));
      } else if (frame?.msgid === PUSH.DZPK_RESULT_BLOCKCHAIN_INFO && requested) {
        const data = frame.payload;
        finish(Array.isArray(data?.pokerList) && data.pokerList.length && Number(data.currentInning) === currentInning
          ? { msgCode: 200, errMsg: null, data }
          : { msgCode: 404, errMsg: "该局公正码不存在、已过期或无权查看", data: null });
      }
    });
  });
}
