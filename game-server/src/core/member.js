import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const avatarDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../static/avator");
const avatarFiles = fs.existsSync(avatarDir)
  ? fs.readdirSync(avatarDir).filter((file) => /^\d+\.(?:png|jpe?g|webp)$/i.test(file)).sort()
  : [];

function avatarFor(uid) {
  if (!avatarFiles.length) return "";
  const value = String(uid ?? "");
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return `/avator/${avatarFiles[hash % avatarFiles.length]}`;
}

export function userInfoOf(member) {
  return {
    uid: member.uid,
    name: String(member.name ?? member.uid),
    icon: member.icon || avatarFor(member.uid),
    sex: 0,
    level: 0,
    isOnLine: true,
    coin: 0,
    isGaming: true,
    remarkName: "",
    regionCode: "CN",
  };
}

export function publicSeat(member) {
  const userInfo = userInfoOf(member);
  return {
    uid: member.uid,
    name: userInfo.name,
    userInfo,
    pos: member.pos,
    state: member.folded ? 3 : member.state,
    score: 0,
    point: Number(member.point) || 0,
    clubId: member.clubId || 0,
    banker: Boolean(member.dealer),
    tuoGuanState: Boolean(member.tuoGuanState),
    tuoGuanLeftTime: member.tuoGuanLeftTime || 0,
    carryLeftTime: member.carryLeftTime || 0,
    lastOperation: Number(member.lastOperation) || 0,
    xiaZhuData: member.totalBet || 0,
  };
}

export function publicObserver(member) {
  const userInfo = userInfoOf(member);
  return {
    uid: member.uid,
    name: userInfo.name,
    userInfo,
    point: Number(member.point) || 0,
  };
}

export function emptySeat(pos) {
  return {
    pos,
    state: 0,
    score: 0,
    point: 0,
    banker: false,
    lastOperation: 0,
    xiaZhuData: 0,
  };
}

export function memberListSeats(members, maxPeople) {
  const byPos = new Map((members || []).map((item) => [item.pos, item]));
  const list = [];
  for (let pos = 0; pos < maxPeople; pos += 1) {
    const seated = byPos.get(pos);
    list.push(seated ? publicSeat(seated) : emptySeat(pos));
  }
  return list;
}
