import WebSocket from "ws";

export function requestRoomPool(runtime, params, action, selection = {}) {
  const configured = String(runtime.config.game_server || "127.0.0.1:11041");
  const endpoint = new URL(configured.includes("://") ? configured : "ws://" + configured);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let done = false;
    const finish = (error, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve(data);
    };
    const unavailable = () => finish(Object.assign(new Error("房间服务暂不可用"), { code: 503 }));
    const timer = setTimeout(() => { unavailable(); socket.terminate(); }, 3000);
    socket.on("error", unavailable);
    socket.on("close", () => { if (!done) unavailable(); });
    socket.on("open", () => socket.send(JSON.stringify({
      type: "room-pool", action, userId: Number(params.userId), token: String(params.token || params.userToken || ""),
      ...selection,
    })));
    socket.on("message", (raw) => {
      let response;
      try { response = JSON.parse(raw.toString()); } catch { unavailable(); return; }
      if (response?.type !== "room-pool-result") { unavailable(); return; }
      if (response.code !== 200) {
        finish(Object.assign(new Error(response.error || "房间分配失败"), { code: response.code || 503 }));
        return;
      }
      finish(null, response.data);
    });
  });
}
