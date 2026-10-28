// Resolve a batch of claims against opening balances, with proportional caps.
// Multiple winners share a short payer fairly; packet/response order is inert.
function allocate(rows, limit) {
  const total = rows.reduce((n, row) => n + row.amount, 0);
  if (total <= limit) return;
  const parts = rows.map(row => ({ row, exact: row.amount * limit / total }));
  let remainder = limit;
  for (const part of parts) { part.row.amount = Math.floor(part.exact); remainder -= part.row.amount; }
  parts.sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.row.to.pos - b.row.to.pos || a.row.from.pos - b.row.from.pos);
  for (let i = 0; i < remainder; i++) parts[i].row.amount++;
}
export function transfer(claims, category = 5, categoryName = '胡分') {
  const rows = claims.map(c => ({ ...c, amount: Math.max(0, Math.floor(c.amount)) }));
  const winners = [...new Set(rows.map(c => c.to))];
  for (const to of winners) allocate(rows.filter(c => c.to === to), Math.min(to.openingPoint, to.member.point));
  for (const from of new Set(rows.map(c => c.from))) allocate(rows.filter(c => c.from === from), from.member.point);
  for (const { from, to, amount } of rows) {
    from.member.point -= amount; to.member.point += amount;
    from.delta -= amount; to.delta += amount;
    from.member.totalBet = (from.member.totalBet || 0) + amount;
    from.details.push({ category, categoryName, score: -amount, otherUid: to.uid });
    to.details.push({ category, categoryName, score: amount, otherUid: from.uid });
  }
  return rows;
}
