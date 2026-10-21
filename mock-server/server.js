import express from "express";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { WebSocketServer } from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../static");
const logDir = path.join(here, "logs");
const logFile = path.join(logDir, "hall-http.log");
const websocketLogFile = path.join(logDir, "game-websocket.log");
const app = express();

fs.mkdirSync(logDir, { recursive: true });

let requestId = 0;

function writeHttpLog(event) {
  const record = {
    time: new Date().toISOString(),
    ...event,
  };
  const line = JSON.stringify(record);
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
  console.log(`[hall ${event.type}]`, record);
}

function decodeParams(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  try {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    return Object.fromEntries(new URLSearchParams(decoded).entries());
  } catch {
    return null;
  }
}

function writeWebSocketLog(event) {
  const record = {
    time: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(websocketLogFile, `${JSON.stringify(record)}\n`, "utf8");
  console.log(`[game websocket ${event.type}]`, record);
}

function parseJsonOrText(buffer) {
  const text = buffer.toString("utf8");
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text };
  }
}

function decodeCustomFrame(buffer) {
  if (buffer.length < 8 || buffer[0] !== 0xc0) {
    return null;
  }

  const flags = buffer[1];
  const messageId = buffer.readInt16BE(2);
  const bodyLength = buffer.readUInt32BE(4);
  if (bodyLength > buffer.length - 8) {
    return null;
  }

  let body = buffer.subarray(8, 8 + bodyLength);
  if (flags & 0x40) {
    try {
      body = inflateSync(body);
    } catch (error) {
      return {
        protocol: "custom-json",
        messageId,
        flags,
        compressed: true,
        decodeError: error.message,
      };
    }
  }

  return {
    protocol: "custom-json",
    messageId,
    messageIdHex: `0x${messageId.toString(16)}`,
    flags,
    compressed: Boolean(flags & 0x40),
    ...parseJsonOrText(body),
  };
}

function readVarInt(buffer, offset) {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = buffer[cursor++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) {
      return { value, offset: cursor };
    }
    shift += 7;
  }
  throw new Error("incomplete varint");
}

function decodePomeloMessage(buffer) {
  if (!buffer.length) {
    return null;
  }

  let offset = 0;
  const flag = buffer[offset++];
  const compressRoute = Boolean(flag & 0x01);
  const type = (flag >> 1) & 0x07;
  let id = 0;
  if (type === 0 || type === 2) {
    ({ value: id, offset } = readVarInt(buffer, offset));
  }

  let route = null;
  if (type === 0 || type === 1 || type === 3) {
    if (compressRoute) {
      route = buffer.readUInt16BE(offset);
      offset += 2;
    } else {
      const routeLength = buffer[offset++];
      route = buffer.subarray(offset, offset + routeLength).toString("utf8");
      offset += routeLength;
    }
  }

  const body = buffer.subarray(offset);
  return {
    protocol: "pomelo-message",
    type,
    id,
    route,
    compressRoute,
    ...parseJsonOrText(body),
  };
}

function decodeWebSocketFrame(data) {
  const buffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data instanceof ArrayBuffer ? data : String(data));
  const custom = decodeCustomFrame(buffer);
  if (custom) {
    return { frameType: "binary", frames: [custom] };
  }

  const frames = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const packetType = buffer[offset];
    const bodyLength = buffer.readUIntBE(offset + 1, 3);
    if (offset + 4 + bodyLength > buffer.length) {
      break;
    }
    const body = buffer.subarray(offset + 4, offset + 4 + bodyLength);
    const packet = {
      protocol: "pomelo-package",
      packetType,
      packetTypeName:
        {
          1: "HANDSHAKE",
          2: "HANDSHAKE_ACK",
          3: "HEARTBEAT",
          4: "DATA",
          5: "KICK",
        }[packetType] || "UNKNOWN",
      length: bodyLength,
    };
    if (packetType === 4) {
      Object.assign(packet, decodePomeloMessage(body));
    } else if (body.length) {
      Object.assign(packet, parseJsonOrText(body));
    }
    frames.push(packet);
    offset += 4 + bodyLength;
  }

  return {
    frameType: typeof data === "string" ? "text" : "binary",
    frames: frames.length ? frames : undefined,
  };
}

const rooms = [
  {
    roomId: 100001,
    roomType: 58,
    gameRoomConfigId: 1,
    totalPeople: 12,
    playMode: 1,
    roomClassification: 0,
    key: "mock-100001",
    smallBlind: 1,
    bigBlind: 2,
    carryMin: 100,
    initialBet: 0,
  },
  {
    roomId: 100002,
    roomType: 58,
    gameRoomConfigId: 2,
    totalPeople: 38,
    playMode: 2,
    roomClassification: 0,
    key: "mock-100002",
    smallBlind: 2,
    bigBlind: 4,
    carryMin: 200,
    initialBet: 0,
  },
  {
    roomId: 100003,
    roomType: 58,
    gameRoomConfigId: 3,
    totalPeople: 6,
    playMode: 1,
    roomClassification: 0,
    key: "mock-100003",
    smallBlind: 5,
    bigBlind: 10,
    carryMin: 500,
    initialBet: 0,
  },
  {
    roomId: 100004,
    roomType: 58,
    gameRoomConfigId: 4,
    totalPeople: 21,
    playMode: 3,
    roomClassification: 0,
    key: "mock-100004",
    smallBlind: 10,
    bigBlind: 20,
    carryMin: 1000,
    initialBet: 0,
  },
].map((room) => ({
  ...room,
  seatInfoList: null,
  winStreakList: null,
  gameStatus: 0,
  gameStatusStartTime: 0,
  gameStatusDuration: 0,
  serverNow: Date.now(),
  straddle: false,
  ante: 0,
  scoreMode: null,
  seeCardNo: 0,
  aofBet: null,
  hundredGame: 0,
  openHundredGame: false,
  hundredMinBet: 0,
  waysJson: null,
  extendInfo: null,
}));

function response(op) {
  switch (op) {
    // Room list for the 1000 lobby. The page consumes roomInfoData.
    case 35:
    case 38:
      return { gameType: 1000, roomClassifications: [], roomInfoData: rooms };
    case 53:
      return {
        userId: 10001,
        uid: 10001,
        userToken: "mock-token",
        clubId: 125566,
        gameIp: "localhost:3000",
        walletAmount: 1000000,
        ticketNums: 0,
      };
    case 54:
      return { walletAmount: 1000000, ticketNums: 0 };
    case 59:
      return {
        userId: 10001,
        uid: 10001,
        name: "模拟玩家",
        avatar: "/avator/90002.png",
      };
    case 63:
      return [];
    default:
      return [];
  }
}

app.use(express.json());
app.use("/_next", express.static(path.join(root, "hall/_next")));
app.use("/l01", express.static(path.join(root, "hall/l01")));
app.use("/avator", express.static(path.join(root, "avator")));
app.use("/client", express.static(path.join(root, "client")));

function mockApi(req, res) {
  const op = Number(req.query.op);
  const id = ++requestId;
  const startedAt = Date.now();
  const request = {
    id,
    type: "request",
    method: req.method,
    url: req.originalUrl,
    query: req.query,
    op,
    params: decodeParams(req.query.param),
  };
  writeHttpLog(request);

  const body = { msgCode: 200, errMsg: null, data: response(op) };
  writeHttpLog({
    id,
    type: "response",
    method: req.method,
    url: req.originalUrl,
    op,
    status: 200,
    body,
    durationMs: Date.now() - startedAt,
  });

  res.set("Cache-Control", "no-store").json(body);
}

app.get("/internal/v1/do", mockApi);
app.get("/api/internal/v1/do", mockApi);

const hallTemplate = fs.readFileSync(
  path.join(root, "hall/21/0/index.html"),
  "utf8",
);

function renderHall(req, res) {
  const gameType = req.params.gameType || "21";
  const subGameType = req.params.subGameType || "0";
  const nextDataPattern =
    /(<script id="__NEXT_DATA__" type="application\/json">)(.*?)(<\/script>)/s;
  const match = hallTemplate.match(nextDataPattern);

  if (!match) {
    return res.status(500).send("大厅模板缺少 __NEXT_DATA__");
  }

  const nextData = JSON.parse(match[2]);
  nextData.props.pageProps.initialGameType = Number(gameType);
  nextData.props.pageProps.initialSubGameType = Number(subGameType);
  nextData.query = { ...req.query, gameType, subGameType };

  const html = hallTemplate.replace(
    nextDataPattern,
    `$1${JSON.stringify(nextData)}$3`,
  );
  res.send(html);
}

app.get(
  ["/", "/hall", "/:gameType/:subGameType", "/hall/:gameType/:subGameType"],
  renderHall,
);

function attachWebSocketLogging(server) {
  const websocketServer = new WebSocketServer({ server });
  let websocketConnectionId = 0;

  websocketServer.on("connection", (socket, request) => {
    const connectionId = ++websocketConnectionId;
    const connection = {
      connectionId,
      url: request.url,
      remoteAddress: request.socket.remoteAddress,
      protocol: request.headers["sec-websocket-protocol"] || null,
    };
    writeWebSocketLog({ type: "connection", ...connection });

    socket.on("message", (data) => {
      const buffer = Buffer.isBuffer(data)
        ? data
        : Buffer.from(data instanceof ArrayBuffer ? data : String(data));
      writeWebSocketLog({
        type: "receive",
        ...connection,
        bytes: buffer.length,
        hex: buffer.toString("hex"),
        base64: buffer.toString("base64"),
        decoded: decodeWebSocketFrame(data),
      });
    });

    socket.on("error", (error) => {
      writeWebSocketLog({
        type: "error",
        ...connection,
        error: error.message,
      });
    });

    socket.on("close", (code, reason) => {
      writeWebSocketLog({
        type: "close",
        ...connection,
        code,
        reason: reason.toString("utf8"),
      });
    });
  });
}

const listen = app.listen.bind(app);
app.listen = (...args) => {
  const server = listen(...args);
  attachWebSocketLogging(server);
  return server;
};

app.listen(3000, () => console.log("模拟大厅: http://localhost:3000/21/0/"));
