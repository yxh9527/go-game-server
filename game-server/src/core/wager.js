// Client amounts may use display units; all debits use integer score units.
// Never coerce arrays, booleans, empty strings or objects into money.
export function scoreAmount(value, scale = 1) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  if (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value)) return NaN;
  const number = Number(value), scaled = number * scale, score = Math.round(scaled);
  if (scale === 1 && !Number.isSafeInteger(number)) return NaN;
  if (number > 0 && score === 0) return NaN;
  if (!Number.isFinite(number) || number < 0 || !Number.isSafeInteger(score)
    || Math.abs(scaled - score) > 0.0000001) return NaN;
  return score;
}

export function validWager(amount, available, min = 1, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(amount) && amount > 0 && Number.isSafeInteger(available)
    && available >= amount && amount >= min && amount <= max;
}

export function checkedTotal(amounts) {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(total + amount)) return NaN;
    total += amount;
  }
  return total;
}

export function beforeWagerDeadline(deadline, now = Date.now()) {
  // Older resident tables may not have a deadline until their first tick.
  return deadline == null || Number.isFinite(deadline) && now < deadline;
}
