import { PUSH } from "../../messages.js";
import { credit, debit } from "../../wallet/index.js";

export function createScratchTable(roomId, roomType, roomRow, gameConfig) {
  return {
    gameId: gameConfig.id,
    kind: gameConfig.kind,
    roomId: Number(roomId),
    roomType: Number(roomType) || gameConfig.roomTypes[0],
    cfg: roomRow || {},
    config: gameConfig,
    gameRoomId: Number(roomId) + 1000000,
    history: [],
    roomIndex: Number(roomRow?.room_index || gameConfig.defaultRoomIndex || 0),
  };
}

export function scratchConf(table) {
  const cfg = table.config;
  return {
    roomType: cfg.confRoomType,
    gglParams: {
      gameName: cfg.gameName,
      gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
      maxBet: Number(table.cfg?.hundred_max_bet || cfg.defaultMaxBet),
      roomIndex: table.roomIndex,
      title: cfg.title,
    },
    gameRoomConfigId: Number(table.cfg?.game_room_config_id || cfg.defaultConfigId),
    playMode: 0,
  };
}

export function scratchState(table, session) {
  const cfg = table.config;
  return {
    code: 0,
    roomId: table.roomId,
    gameRoomId: table.gameRoomId,
    roomTypeCode: table.roomType,
    pendingTickets: [],
    walletAmount: session.wallet,
    winMultipliers: cfg.winMultipliers,
    denominations: cfg.denominations,
    accumulatedWin: session.accumulatedWin || 0,
    accumulatedWinByKind: session.accumulatedWinByKind || { GGL1: 0, GGL2: 0 },
  };
}

export function prizeFromMask(huMask, prizeTiers) {
  const counts = new Map();
  for (const n of huMask) {
    counts.set(n, (counts.get(n) || 0) + 1);
  }
  const huCount = Math.max(0, ...counts.values());
  const hit = (prizeTiers || []).find((item) => huCount >= item.min);
  return {
    huCount,
    multiplier: hit?.multiplier || 0,
    prizeTier: hit?.tier || "NONE",
  };
}

export function buyTicket(table, session, body, host) {
  const cfg = table.config;
  const faceValue = Number(body?.faceValue || 100);
  const kind = String(body?.kind || "ggl1").toLowerCase();
  if (faceValue <= 0 || !debit(session, faceValue, host).ok) {
    return { ...scratchState(table, session), code: 1, winAmount: 0, prizeTier: "NONE" };
  }
  const huMask = Array.from({ length: cfg.maskSize || 20 }, () => 2 + Math.floor(Math.random() * 9));
  const { huCount, multiplier, prizeTier } = prizeFromMask(huMask, cfg.prizeTiers);
  const winAmount = Math.floor(faceValue * multiplier);
  credit(session, winAmount, host);
  session.accumulatedWin = (session.accumulatedWin || 0) + winAmount;
  const kindKey = kind.toUpperCase();
  session.accumulatedWinByKind = session.accumulatedWinByKind || { GGL1: 0, GGL2: 0 };
  session.accumulatedWinByKind[kindKey] = (session.accumulatedWinByKind[kindKey] || 0) + winAmount;
  const now = new Date();
  const stamp = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  const serialFull = `${kind}-${stamp}-${table.gameRoomId}-${session.userId}-${table.history.length + 1}`;
  const result = {
    code: 0,
    roomId: table.roomId,
    gameRoomId: table.gameRoomId,
    roomTypeCode: table.roomType,
    serialFull,
    huCount,
    multiplier,
    winAmount,
    prizeTier,
    huMask,
    walletAmount: session.wallet,
    gglKind: kindKey,
    accumulatedWin: session.accumulatedWin,
    accumulatedWinByKind: session.accumulatedWinByKind,
  };
  table.history.unshift({
    huCount,
    amount: winAmount - faceValue,
    huMask,
    faceValue,
    multiplier,
    roomType: table.roomType,
    serialNo: serialFull,
  });
  table.history = table.history.slice(0, 100);
  return result;
}

export function onScratchJoin(send, table) {
  send(PUSH.ROOM_TYPE_RESULT, {
    roomId: table.roomId,
    roomType: table.roomType,
    conf: scratchConf(table),
  });
}

export function onScratchState(send, table, session) {
  send(PUSH.GGL_STATE, scratchState(table, session));
}

export function onScratchBuy(send, table, session, body) {
  send(PUSH.GGL_RESULT, buyTicket(table, session, body || {}));
}

export function onScratchHistory(send, table) {
  send(PUSH.RETURN_100_RECORD, {
    gameRoomId: table.gameRoomId,
    winInfo: table.history,
  });
}
