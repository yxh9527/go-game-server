import { createCipheriv, randomBytes,createHash } from "node:crypto";
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
  if(io.env==='prod'){
    const proof=table.fairPersistence||={pending:new Map(),messages:[],bytes:0,task:null};
    record.proofId=createHash('sha256').update([table.agentId,table.gameId,table.roomId,table.createdAt||table.userCenterCreatedAt||record.createdAt,currentInning].join(':')).digest('hex');
    record.agentId=Number(table.agentId);record.gameId=table.gameId;record.version=1;
    proof.write=io.writeFairProof;proof.pending.set(currentInning,record);
    const start=()=>void flushFairProof(table);
    if(io.wallet?.deliver)io.wallet.deliver(start);else start();
  }
  records(table).set(currentInning, record);
  records(table);
  io.broadcast(PUSH.DZPK_PUSH_BLOCKCHAIN_NOTIFY, notify(record));
}

export function watchFairHand(table, uid) {
  const record = records(table).get(Number(table.currentInning));
  if (record && !record.finishedAt&&!record.viewers.has(Number(uid))) {record.viewers.add(Number(uid));queueFairProof(table,record);}
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
    // Variable-hand games commit a neutral shoe before betting. They may
    // disclose only the physical indices actually dealt face up this hand.
    if (record.holeCount === 0 && Array.isArray(result.publicDeckIndices)) {
      record.revealedCards ||= new Set();
      for (const index of result.publicDeckIndices) {
        if (Number.isInteger(index) && index >= 0 && index < record.pokerList.length) record.revealedCards.add(index);
      }
    }
    if (result.showCards?.length && result.showCards.every((card) => card >= 0)) record.revealed.add(Number(result.uid));
    record.revealedCards ||= new Set();
    for (const card of record.pokerList) {
      if (Number(card.ownerUid) === Number(result.uid)
        && result.showCards?.includes(JSON.parse(card.pokerInfo).index)) record.revealedCards.add(card.deckIndex);
    }
  }
  queueFairProof(table,record);
}

function queueFairProof(table,record){
  if(!table.fairPersistence)return;
  record.version=(record.version||0)+1;table.fairPersistence.pending.set(record.currentInning,record);
}
function serializeProof(record){return {...record,viewers:[...record.viewers],revealed:[...record.revealed],revealedCards:[...(record.revealedCards||[])]};}
export function restoreFairProof(record){return {...record,viewers:new Set(record.viewers||[]),revealed:new Set(record.revealed||[]),revealedCards:new Set(record.revealedCards||[])};}
export async function flushFairProof(table,at=Date.now()){
 const p=table.fairPersistence;if(!p?.pending.size||p.task)return p?.task;
 if(p.retryAt>at)return;
 if(typeof p.write!=='function')return;
 const task=(async()=>{
  for(const [inning,record]of p.pending){
   const version=record.version;await p.write(serializeProof(record));
   if(record.version===version)p.pending.delete(inning);
  }
  if(!p.pending.size){
   p.failures=0;delete p.retryAt;delete p.lastError;
   if(table.hand&&p.blockedAt){const duration=Date.now()-p.blockedAt;for(const key of ['deadline','aofNextAt'])if(Number.isFinite(table.hand[key]))table.hand[key]+=duration;}delete p.blockedAt;
   const messages=p.messages.splice(0);p.bytes=0;for(const deliver of messages)deliver();
  }
 })().catch(error=>{p.lastError=String(error.message);p.failures=(p.failures||0)+1;p.retryAt=at+Math.min(30000,1000*2**Math.min(5,p.failures));});
 p.blockedAt||=Date.now();p.task=task;try{await task}finally{if(p.task===task)p.task=null}
}
export function deliverAfterFairProof(table,ws,frame,send){
 const p=table?.fairPersistence;if(!p?.pending.size){send();return}
 if(p.messages.length>=2000||p.bytes+frame.length>4*1024*1024){ws.close?.(1013,'Fair proof storage pending');return;}
 p.bytes+=frame.length;p.messages.push(send);
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
      : record.revealedCards?.has(card.deckIndex) || record.isHoldem && boardIndex >= 0 && boardIndex < record.boardCount);
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
