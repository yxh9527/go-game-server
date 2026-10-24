export async function getDevHoldemRecordDetail(runtime, gameRoomId, inningNum) {
  if (!gameRoomId || !inningNum) return null;
  const configured = String(runtime.config.game_server || "127.0.0.1:11041");
  const base = /^https?:\/\//i.test(configured) ? configured : `http://${configured}`;
  const endpoint = new URL("/internal/dev/holdem-record-detail", base);
  endpoint.searchParams.set("roomId", String(gameRoomId));
  endpoint.searchParams.set("inningNum", String(inningNum));
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const body = await response.json();
  return body?.code === 0 && Array.isArray(body.data?.exploitsInfoMsgs) && body.data.exploitsInfoMsgs.length
    ? body.data
    : null;
}
