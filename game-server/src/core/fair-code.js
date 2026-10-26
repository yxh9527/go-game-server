import { createCipheriv, randomBytes } from "node:crypto";
import { rel } from "../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { PUSH } = await rel(import.meta.url, "../messages.js", version);

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_HANDS = 128;
const positiveInteger = (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0;

function records(table, now = Date.now()) {
  table.fairCodes ||= new Map();
  for (const [inning, record] of table.fairCodes) {
    if (record.finishedAt && now - record.finishedAt > TTL_MS) table.fairCodes.delete(inning);
  }
  while (table.fairCodes.size > MAX_HANDS) table.fairCodes.delete(table.fairCodes.keys().next().value);
  return table.fairCodes;
}

function notify(record) {
  return {
    gameRoomId: record.gameRoomId, roomType: record.roomType,
    currentInning: record.currentInning, notarizationCode: record.notarizationCode,
  };
}

export function beginFairHand(io, table, players, holeCount) {
  // Production must obtain commitments/keys from its authoritative lottery
  // provider. Local proofs are a development adapter, not an on-chain claim.
  if (io.env === "prod") return;
  const hand = table.hand;
  if (!hand?.deck?.length) return;
  const currentInning = Number(table.currentInning);
  const existing = records(table).get(currentInning);
  if (existing) return; // Never replace a commitment already published to players.
  const isHoldem = table.gameId === "holdem" || [19, 101].includes(Number(table.roomType));
  const holeEnd = players.length * holeCount;
  const pokerList = hand.deck.map((card, index) => {
    const owner = index < holeEnd ? players[Math.floor(index / holeCount)] : null;
    const publicIndex = index - holeEnd;
    const pokerInfo = JSON.stringify({
      index: card, position: owner ? Math.floor(index / holeCount) + 1 : -1,
      action: owner ? String(owner.pos + 1) : "",
      currentInning, gameRoomId: table.roomId,
      flop: isHoldem && publicIndex >= 1 && publicIndex <= 3,
      turn: isHoldem && publicIndex === 5, river: isHoldem && publicIndex === 7,
    });
    // The original client links an AES-256-ECB decoder and copies these two
    // strings. Independent random keys allow selective disclosure of cards.
    const secretKey = randomBytes(24).toString("base64"); // 32 UTF-8 bytes
    const cipher = createCipheriv("aes-256-ecb", Buffer.from(secretKey, "utf8"), null);
    const encryptedStr = Buffer.concat([cipher.update(pokerInfo, "utf8"), cipher.final()]).toString("base64");
    return { pokerInfo, secretKey, encryptedStr, ownerUid: owner?.uid, deckIndex: index };
  });
  const record = {
    gameRoomId: Number(table.roomId), roomType: Number(table.roomType), currentInning,
    createdAt: Date.now(), finishedAt: 0, holeEnd, isHoldem, holeCount,
    playerIds: players.map((member) => Number(member.uid)),
    viewers: new Set([...(table.observers || []), ...players].map((member) => Number(member.uid))),
    revealed: new Set(), boardCount: 0, pokerList,
    notarizationCode: pokerList.map((card) => card.encryptedStr).join(""),
  };
  records(table).set(currentInning, record);
  records(table);
  io.broadcast(PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY, notify(record));
}

export function watchFairHand(table, uid) {
  const record = records(table).get(Number(table.currentInning));
  if (record && !record.finishedAt) record.viewers.add(Number(uid));
}

export function currentFairCode(table, uid) {
  watchFairHand(table, uid);
  const record = records(table).get(Number(table.currentInning));
  return record?.viewers.has(Number(uid)) ? notify(record) : null;
}

export function finishFairHand(table, results) {
  const record = records(table).get(Number(table.currentInning));
  if (!record || record.finishedAt) return;
  record.finishedAt = Date.now();
  record.boardCount = table.hand?.board?.length || 0;
  for (const result of results) {
    if (result.showCards?.length && result.showCards.every((card) => card >= 0)) record.revealed.add(Number(result.uid));
    record.revealedCards ||= new Set();
    for (const card of record.pokerList) {
      if (Number(card.ownerUid) === Number(result.uid)
        && result.showCards?.includes(JSON.parse(card.pokerInfo).index)) record.revealedCards.add(card.deckIndex);
    }
  }
}

export function fairCodeList(table, uid) {
  return [...records(table).values()].filter((record) => record.viewers.has(Number(uid))).reverse().map((record) => ({
    gameRoomId: record.gameRoomId, roomType: record.roomType, currentInning: record.currentInning,
    status: record.finishedAt ? 10 : 20,
    endTime: record.finishedAt ? new Date(record.finishedAt).toISOString() : "",
    handPais: record.finishedAt ? record.pokerList.filter((card) => card.ownerUid === Number(uid))
      .map((card) => JSON.parse(card.pokerInfo).index) : [],
    // Completed entries request op=29. Active entries only show the commitment.
    notarizationCode: record.finishedAt ? "" : record.notarizationCode,
  }));
}

export function fairCodeDetail(table, uid, inning) {
  if (!positiveInteger(uid) || !positiveInteger(inning)) return null;
  const record = records(table).get(Number(inning));
  if (!record || !record.viewers.has(Number(uid))) return null;
  const pokerList = [];
  for (const card of record.pokerList) {
    const info = JSON.parse(card.pokerInfo);
    const publicIndex = card.deckIndex - record.holeEnd;
    const boardIndex = [1, 2, 3, 5, 7].indexOf(publicIndex);
    const visible = record.finishedAt && (card.ownerUid != null
      ? Number(card.ownerUid) === Number(uid) || record.revealed.has(Number(card.ownerUid)) || record.revealedCards?.has(card.deckIndex)
      : record.isHoldem && boardIndex >= 0 && boardIndex < record.boardCount);
    // The server never releases the keys of undealt or unrevealed opponent
    // cards. Negative placeholders identify hidden dealt cards in the client's
    // getCardByPokerIndex without publishing their actual rank/suit.
    const publicInfo = visible ? info : {
      index: card.ownerUid != null ? -2 - card.deckIndex : -1,
      position: info.position, action: info.action, currentInning: record.currentInning,
      flop: false, turn: false, river: false,
    };
    pokerList.push({
      currentInning: record.currentInning, position: info.position,
      encryptedStr: card.encryptedStr, secretKey: visible ? card.secretKey : "",
      pokerInfo: JSON.stringify(publicInfo),
    });
  }
  return {
    ...notify(record), pokerList,
    roomConfig: JSON.stringify({
      playerIds: record.playerIds, cutCardIndex: 0,
      playerShowStatus: Object.fromEntries([...record.revealed].map((id) => [id, true])),
      roomConfig: { forceShowCard: false },
    }),
  };
}
