import http from "node:http";

export function isGameStaticHost(hostHeader) {
  const name = String(hostHeader || "").split(":")[0];
  return name === "www.localhost" || name.startsWith("www.") || name.startsWith("game-h5.");
}

export function isHallApiPath(url) {
  const pathName = String(url || "").split("?")[0];
  return pathName === "/api" || pathName.startsWith("/api/");
}

export function proxyToClientWeb(req, res, target, log = console) {
  const [hostname, port] = String(target).split(":");
  const headers = { ...req.headers, host: `${hostname}:${port || 80}` };
  const upstream = http.request({
    hostname,
    port: Number(port || 80),
    path: req.url,
    method: req.method,
    headers,
  }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on("error", (err) => {
    log.error?.("[hall] client-web proxy", err.message);
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("game static site unavailable");
    }
  });
  req.pipe(upstream);
}
