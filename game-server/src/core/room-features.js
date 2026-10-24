import { rel } from "../rel.js";

const version = new URL(import.meta.url).searchParams.get("v") || "0";
const { PUSH, SEND } = await rel(import.meta.url, "../messages.js", version);
const { publicObserver, userInfoOf } = await rel(import.meta.url, "./member.js", version);
const lifecycle = await rel(import.meta.url, "./room-lifecycle.js", version);

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

export function initializeRoomStats(table) {
  lifecycle.initializeLifetime(table);
  return table.roomFeatures ||= {
    players: new Map(), startedAt: table.createdAt, totalHands: 0,
    totalStream: 0, totalPot: 0, settledInning: 0,
  };
}

const state = initializeRoomStats;

function player(table, member, initialPoint = 0) {
  const data = state(table);
  const uid = Number(member.uid);
  let row = data.players.get(uid);
  if (!row) {
    row = { uid, totalPoint: number(initialPoint), carryOutPoint: 0, totalHands: 0, totalStream: 0, winLostScore: 0 };
    data.players.set(uid, row);
  }
  row.userInfo = userInfoOf(member);
  row.userName = row.userInfo.name;
  row.userIcon = row.userInfo.icon;
  return row;
}

export function syncMembers(table) {
  for (const member of table.members || []) {
    player(table, member, number(member.point) + (table.phase === "playing" ? number(member.totalBet) : 0));
  }
}

export function recordCarryIn(table, member, amount) {
  player(table, member).totalPoint += number(amount);
}

export function recordCarryOut(table, member, amount) {
  player(table, member, number(member.point) + number(member.totalBet)).carryOutPoint += number(amount);
}

export function beginHandStats(table, players) {
  syncMembers(table);
  // Keep participant references when somebody leaves before this hand settles.
  // Their committed bets still belong to this hand, even after seat removal.
  table.hand.statsPlayers = players.slice();
}

export function finishHandStats(table, results) {
  const data = state(table);
  const inning = number(table.currentInning);
  if (inning <= data.settledInning) return;
  const participants = table.hand?.statsPlayers || (table.members || []).filter((member) => member.hole?.length);
  const byUid = new Map(results.map((result) => [Number(result.uid), result]));
  let stream = 0;
  for (const member of participants) {
    const result = byUid.get(Number(member.uid));
    const row = player(table, member, number(member.openingPoint));
    const bet = result ? number(result.xiaZhuData) : number(member.totalBet);
    row.totalHands += 1;
    row.winLostScore += result ? number(result.score) : -number(member.totalBet);
    row.totalStream = number(row.totalStream) + bet;
    stream += bet;
  }
  data.totalHands += 1;
  data.totalStream += stream;
  data.totalPot += number(table.hand?.pot);
  data.settledInning = inning;
}

export function observerList(table) {
  const seated = new Set((table.members || []).map((member) => Number(member.uid)));
  const seen = new Set();
  return (table.observers || []).filter((member) => {
    const uid = Number(member.uid);
    if (seated.has(uid) || seen.has(uid)) return false;
    seen.add(uid);
    return true;
  }).map((member) => {
    const row = state(table).players.get(Number(member.uid));
    return publicObserver({ ...member, winLostScore: row?.winLostScore || 0, totalHands: row?.totalHands || 0 });
  });
}

function sendRoomFeatures(table, send, includeObservers) {
  // CommonRankUI opens its cached data without a ranking request. Sending
  // observers alone makes SetRankObUser create a partial object with no clock.
  const report = ranking(table);
  send(PUSH.DZPK_PUSH_RANKINGLIST, report);
  if (includeObservers) send(PUSH.DZPK_PUSH_WATCHGAME, report.obMemberList);
  return report;
}

// Games call this after their settlement result. Message ids, payload shape
// and ordering belong here, not in each game's engine.
export function pushRanking(ctx) {
  return sendRoomFeatures(ctx.table, (id, payload) => ctx.io.broadcast(id, payload), false);
}

export function pushObservers(ctx) {
  return sendRoomFeatures(ctx.table, (id, payload) => ctx.io.broadcast(id, payload), true);
}

export function ranking(table, now = Date.now()) {
  syncMembers(table);
  const data = state(table);
  const members = new Map((table.members || []).map((member) => [Number(member.uid), member]));
  const userList = [...data.players.values()].map((row) => ({
    ...row, userInfo: { ...row.userInfo }, onTableFlag: members.has(row.uid) ? 1 : 0,
    point: number(members.get(row.uid)?.point),
  })).sort((a, b) => b.onTableFlag - a.onTableFlag || b.winLostScore - a.winLostScore || a.uid - b.uid);
  return {
    userList, obMemberList: observerList(table),
    totalHands: data.totalHands, totalStream: data.totalStream,
    totalTakeIn: userList.reduce((sum, row) => sum + row.totalPoint, 0),
    // This client field is activity points, not chips on seats.
    currentActivePoint: number(table.currentActivePoint),
    averagePot: data.totalHands ? Math.round(data.totalPot / data.totalHands) : 0,
    gameTime: lifecycle.ROOM_LIFETIME_SECONDS, lastTime: lifecycle.remainingSeconds(table, now),
    taxType: number(table.config?.taxType),
    taxPercent: number(table.config?.taxPercent), insuranceProfit: 0,
  };
}

export function handleRoomFeature(ctx, msgid, payload) {
  // The original common ranking button emits DATA_REPORT, not 1144. Refresh
  // its complete cache on this existing event; unrelated reports stay inert.
  const opensRanking = msgid === SEND.DATA_REPORT && payload?.buttonCode === "realtime_rank_main_btn";
  if (msgid !== SEND.SEND_GAME_RANKING_REQ && !opensRanking) return false;
  sendRoomFeatures(ctx.table, (id, payload) => ctx.send(id, payload), true);
  return true;
}
