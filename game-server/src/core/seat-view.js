// The original Zjh/Qznn/Sss spectator layouts put wire position 0 at the bottom.
// Project each connection's seats at the transport boundary; the room, hand,
// wallet, history and fair-code records always retain their real positions.
const POSITION_MESSAGES = new Set([2202, 2206, 3260, 3606, 3610, 3731, 3732, 3741, 3921, 3924, 4401, 4403, 4407, 4550, 4551, 4553, 4554]);

function enabled(table) {
  return table?.kind === 'normal' && !(table.gameId === 'blackjack' && table.playMode === 1)
    && ['zjh', 'niuniu', 'sss', 'blackjack', 'sgay'].includes(table.gameId);
}
function capacity(table) {
  return table.roomRules?.maxPeople || table.config?.maxPeople || 7;
}
function key(table) {
  return `${table.agentId || 0}/${table.gameId}/${table.roomId}`;
}
function current(table, session) {
  return session.seatView?.key === key(table) ? session.seatView : null;
}
function anchor(table) {
  const playing = table.hand?.players || table.hand?.participants;
  const ids = playing && new Set(playing.map(p => p.uid));
  const members = table.members.filter(m => !m.pendingDeparture);
  const ready = members.filter(m => m.point > 0 && !m.carryDeadline && (!ids || ids.has(m.uid)));
  return (ready.length ? ready : members).reduce((pos, m) => Math.min(pos, m.pos), Infinity);
}
function desiredOffset(table, session) {
  const view = current(table, session);
  // Bjk places the observer's bottom chair at maxPeople-1, unlike Zjh/Sss.
  const target = table.gameId === 'blackjack' ? capacity(table) - 1 : 0;
  // Seated clients rotate their own chair. Keep their wire coordinates stable
  // through sit/stand and preserve a live hand's animation coordinates.
  if (view && (table.members.some(m => m.uid === session.userId) || table.hand)) return view.offset;
  if (view && table.members.some(m => m.pos === (view.offset + target) % capacity(table) && m.point > 0
    && !m.carryDeadline && !m.pendingDeparture)) return view.offset;
  const pos = anchor(table);
  return Number.isFinite(pos) ? (pos - target + capacity(table)) % capacity(table) : 0;
}

export function needsSeatViewRefresh(table, session) {
  return enabled(table) && desiredOffset(table, session) !== (current(table, session)?.offset ?? 0);
}

export function projectSeatMessage(table, session, id, payload) {
  // LiveBlackJack's 9212 consumer assigns the payload directly to __myPoint.
  // Its betting UI requires carried score, rather than the ordinary uid/point
  // envelope or the remaining account wallet after carry-in.
  if (table?.gameId === 'blackjack' && table.playMode === 1 && id === 9212) {
    const member = table.members.find(m => m.uid === session.userId);
    if (member?.casinoWalletSession) return member.point + Number(session.wallet || 0);
    return member?.point
      ?? (typeof payload === 'number' ? payload : payload.point);
  }
  if (!enabled(table) || !POSITION_MESSAGES.has(id) || payload == null) return payload;
  if (id === 2206) session.seatView = { key: key(table), offset: desiredOffset(table, session) };
  const offset = current(table, session)?.offset || 0;
  if (!offset) return payload;
  const size = capacity(table);
  const position = pos => Number.isInteger(pos) && pos >= 0 && pos < size
    ? (pos - offset + size) % size : pos;
  const seat = row => row && typeof row === 'object'
    ? { ...row, ...(Object.hasOwn(row, 'pos') ? { pos: position(row.pos) } : {}),
      ...(table.gameId === 'blackjack' && Object.hasOwn(row, 'displaySeat') ? { displaySeat: position(row.displaySeat) } : {}) } : row;
  if (Array.isArray(payload)) return payload.map(seat);
  const result = seat(payload);
  if (Array.isArray(payload.memberList)) result.memberList = payload.memberList.map(seat).sort((a, b) => a.pos - b.pos);
  if (Array.isArray(payload.memberDeskInfos)) result.memberDeskInfos = payload.memberDeskInfos.map(seat);
  if (table.gameId === 'blackjack') {
    for (const field of ['players', 'actionList', 'settleList']) if (Array.isArray(payload[field])) result[field] = payload[field].map(seat);
  }
  if (Object.hasOwn(payload, 'bankerPos')) result.bankerPos = position(payload.bankerPos);
  return result;
}

export function restoreSeatRequest(table, session, id, payload) {
  if (!enabled(table) || id !== 5003 || !payload) return payload;
  const offset = current(table, session)?.offset || 0, size = capacity(table);
  if (!offset) return payload;
  const result = { ...payload };
  for (const field of ['position', 'pos']) {
    if (Number.isInteger(result[field]) && result[field] >= 0 && result[field] < size) {
      result[field] = (result[field] + offset) % size;
    }
  }
  return result;
}
