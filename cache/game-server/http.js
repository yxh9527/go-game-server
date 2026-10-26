export function handleLocalRequest(runtime, req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/internal/dev/holdem-record-detail") return false;
  const roomId = Number(url.searchParams.get("roomId")) || 0;
  const inningNum = Number(url.searchParams.get("inningNum")) || 0;
  const respond = (data) => {
    res.statusCode = data ? 200 : 404;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(data ? { code: 0, data } : { code: 404, data: null }));
  };
  const userId = Number(url.searchParams.get("userId"));
  const token = url.searchParams.get("token");
  (async () => {
    let agentId;
    if (userId > 0) {
      if (!token || !runtime.gateway?.validateToken || !await runtime.gateway.validateToken(token, userId)) {
        respond(null); return;
      }
      const profile = await runtime.gateway.getLoginData(userId);
      agentId = Number(profile?.agentId) || 0;
    }
    respond(runtime.getDevHoldemRecordDetail?.(roomId, inningNum, userId || undefined, agentId) || null);
  })().catch(() => respond(null));
  return true;
}
