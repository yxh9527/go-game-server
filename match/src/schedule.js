const formatters = new Map();
function formatter(zone) {
  if (!formatters.has(zone)) formatters.set(zone, new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }));
  return formatters.get(zone);
}
export function localDate(at, zone) {
  const p = Object.fromEntries(formatter(zone).formatToParts(at).map(p => [p.type, p.value]));
  return p.year + '-' + p.month + '-' + p.day;
}
export function dailyInstant(date, time, zone) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) {
    throw new Error('invalid daily date/time');
  }
  const target = date + 'T' + time + (time.length === 5 ? ':00' : '');
  const naive = Date.parse(target + 'Z');
  if (!Number.isFinite(naive) || new Date(naive).toISOString().slice(0, 19) !== target) throw new Error('invalid calendar date');
  const candidates = new Set();
  // Sample both sides of DST changes, then validate the actual wall clock.
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = naive + hours * 3600000;
    const p = Object.fromEntries(formatter(zone).formatToParts(sample).map(p => [p.type, p.value]));
    const wall = p.year + '-' + p.month + '-' + p.day + 'T' + p.hour + ':' + p.minute + ':' + p.second;
    const candidate = naive - (Date.parse(wall + 'Z') - sample);
    const c = Object.fromEntries(formatter(zone).formatToParts(candidate).map(p => [p.type, p.value]));
    const actual = c.year + '-' + c.month + '-' + c.day + 'T' + c.hour + ':' + c.minute + ':' + c.second;
    if (actual === target) candidates.add(candidate);
  }
  // Ambiguous clocks select the first occurrence; nonexistent clocks are explicit.
  if (!candidates.size) throw new Error('daily start time does not exist in configured timezone');
  return Math.min(...candidates);
}
export function scheduleSlot(schedule, now = Date.now(), nextDay = false) {
  if (schedule.schedule_kind === 'once') {
    const at = Number(schedule.start_time);
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error('start_time must be epoch milliseconds');
    return { key: String(schedule.id) + ':once', startTime: at };
  }
  if (schedule.schedule_kind !== 'daily') throw new Error('invalid schedule_kind');
  let date = localDate(now, schedule.timezone);
  if(nextDay)date=new Date(Date.parse(date+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  return { key: String(schedule.id) + ':' + date, startTime: dailyInstant(date, schedule.daily_time, schedule.timezone) };
}
