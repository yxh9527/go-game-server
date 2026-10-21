const initialGold = 1000000;
const userIdMapGold = new Map();
const tokenBindings = new Map();

export function initUserGold(userId, gold = initialGold) {
  const uid = Number(userId) || 0;
  if (!userIdMapGold.has(uid)) {
    userIdMapGold.set(uid, Number(gold) || initialGold);
  }
  return userIdMapGold.get(uid);
}

export function getUserGold(userId) {
  return initUserGold(userId);
}

export function setUserGold(userId, gold) {
  const uid = Number(userId) || 0;
  const value = Number(gold) || 0;
  userIdMapGold.set(uid, value);
  return value;
}

export function addUserGold(userId, delta) {
  const next = getUserGold(userId) + Number(delta || 0);
  if (next < 0) {
    return { ok: false, balance: getUserGold(userId) };
  }
  setUserGold(userId, next);
  return { ok: true, balance: next };
}

export function bindDevToken(token, userId) {
  const key = String(token || `dev-${userId}`);
  const prev = tokenBindings.get(key);
  if (prev && prev !== Number(userId)) {
    return { ok: false, userId: prev };
  }
  const isReEnter = tokenBindings.has(key);
  tokenBindings.set(key, Number(userId));
  return { ok: true, userId: Number(userId), isReEnter, token: key };
}

export function validateDevToken(token, userId) {
  if (!token) {
    return true;
  }
  const bound = tokenBindings.get(String(token));
  return bound == null || Number(bound) === Number(userId);
}
