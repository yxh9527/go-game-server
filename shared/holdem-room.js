// Hall selectors 0/2/8 differ from room wire modes 1/3/9.
export function holdemRoomSettings(row = {}) {
  row ||= {};
  let data = {};
  try { data = JSON.parse(row.payload || '{}') || {}; } catch {}
  const number = (column, field, fallback) => {
    const n = Number(row[column] ?? data[field] ?? fallback);
    return Number.isFinite(n) ? n : fallback;
  };
  const truthy = value => value === true || value === 1 || value === '1' || value === 'true';
  const bigBlind = number('big_blind', 'bigBlind', 20);
  const playMode = number('play_mode', 'playMode', 0);
  return {
    smallBlind: number('small_blind', 'smallBlind', 10), bigBlind,
    playMode,
    criticalFlag: [2, 3].includes(playMode),
    criticalAnte: Number(row.critical_ante !== undefined ? row.critical_ante
      : data.criticalAnte !== undefined ? data.criticalAnte : 100),
    criticalInterval: String(row.critical_interval ?? data.criticalInterval ?? '5-8'),
    straddle: truthy(row.straddle ?? data.straddle ?? false),
    initialBet: number('initial_bet', 'initialBet', bigBlind), ante: number('ante', 'ante', 0),
    roomClassification: number('room_classification', 'roomClassification', 2),
    carryMin: number('carry_min', 'carryMin', 500), aofBet: number('aof_bet', 'aofBet', 0),
    seeCardNo: number('see_card_no', 'seeCardNo', 3),
    forceShowCard: truthy(row.force_show_card ?? data.forceShowCard ?? false),
  };
}

export function holdemRoomKey(row) {
  const p = holdemRoomSettings(row);
  return [19, p.smallBlind, p.bigBlind, p.straddle, p.playMode, p.initialBet,
    p.roomClassification, p.carryMin, p.aofBet, p.forceShowCard].join('/');
}

export function assertHoldemPlayable(row, roomType = row?.room_type ?? 19) {
  if (Number(roomType) === 101) return;
  const mode = holdemRoomSettings(row).playMode;
  if ([0, 1, 2, 3].includes(mode)) return;
  const name = [8, 9].includes(mode) ? 'AOF必推' : '该德州';
  throw Object.assign(new Error(`${name}玩法尚未开放`), { code: 503 });
}
