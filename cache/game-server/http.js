export function handleLocalRequest(runtime, req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== "/internal/dev/holdem-record-detail") return false;
  const roomId = Number(url.searchParams.get("roomId")) || 0;
  const inningNum = Number(url.searchParams.get("inningNum")) || 0;
  const data = runtime.getDevHoldemRecordDetail?.(roomId, inningNum) || null;
  res.statusCode = data ? 200 : 404;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data ? { code: 0, data } : { code: 404, data: null }));
  return true;
}
