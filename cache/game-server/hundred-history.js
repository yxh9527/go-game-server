// Development history only. Resident room storage survives business hot reloads.
const MAX_RECORDS = 100;
const TTL_MS = 8 * 3600000;

function records(table, now = Date.now()) {
  table.hundredHistory = (table.hundredHistory || [])
    .filter(row => now - row.createdAt < TTL_MS).slice(-MAX_RECORDS);
  return table.hundredHistory;
}

export function record(table, publicResult, viewers, settlements, extras = new Map()) {
  const history = records(table);
  if (history.some(row => row.inning === table.inning)) return;
  const personal = {};
  for (const [uid, bets] of table.playerBets) {
    const result = settlements.get(Number(uid));
    if (!result) continue;
    personal[uid] = Object.fromEntries(bets.map(bet => {
      const realScore = result.areaWinningScores[bet.areaId];
      return [bet.areaId, { areaId: bet.areaId, betScore: bet.total, realScore,
        score: bet.total * (table.hand?.betReserveFactor || 1) + realScore, tax: 0,
        odds: result.betOdds?.[bet.areaId] ?? (table.hand?.areaOdds || table.rules.betAreaOdds)[bet.areaId] }];
    }));
  }
  history.push({ inning: table.inning, createdAt: Date.now(),
    viewers: [...new Set([...viewers.keys(), ...settlements.keys()].map(Number))],
    result: structuredClone(publicResult), personal, extras: structuredClone(Object.fromEntries(extras)) });
  records(table);
}

export function list(table, uid) {
  return { gameRoomId: table.roomId, list: records(table)
    .filter(row => row.viewers.includes(Number(uid))).map(row => row.inning).sort((a, b) => a - b) };
}

export function detail(table, uid, inning) {
  if (!Number.isSafeInteger(inning) || inning <= 0) return null;
  const row = records(table).find(row => row.inning === inning && row.viewers.includes(Number(uid)));
  return row ? { gameRoomId: table.roomId, currInning: row.inning, ...structuredClone(row.result),
    betDetailTableMap: structuredClone(row.personal[Number(uid)] || {}), ...structuredClone(row.extras?.[Number(uid)] || {}) } : null;
}
