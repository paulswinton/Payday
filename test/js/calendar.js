// Civil dates as 'YYYY-MM-DD' strings in Europe/London. No time zones involved.
export const toDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const iso = d => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const weekday = s => toDate(s).getUTCDay(); // 0 Sun .. 6 Sat
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
export const monthKey = s => s.slice(0, 7);
export const lastDayOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export function addMonths(key, n) {
  let [y, m] = key.split('-').map(Number);
  m += n; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function todayLocal(now = new Date()) {
  // The phone's local calendar date (Europe/London for this user).
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}
function firstMonday(y, m) { let s = ymd(y, m, 1); while (weekday(s) !== 1) s = addDays(s, 1); return s; }
function lastMonday(y, m) { let s = ymd(y, m, lastDayOfMonth(y, m)); while (weekday(s) !== 1) s = addDays(s, -1); return s; }

const holidayCache = new Map();
// Bank holidays used by Bacs (England and Wales), which set when payments move.
export function bankHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const set = new Set();
  let ny = ymd(y, 1, 1);
  if (weekday(ny) === 6) ny = ymd(y, 1, 3); else if (weekday(ny) === 0) ny = ymd(y, 1, 2);
  set.add(ny);
  const easter = easterSunday(y);
  set.add(addDays(easter, -2)); set.add(addDays(easter, 1));
  set.add(firstMonday(y, 5)); set.add(lastMonday(y, 5)); set.add(lastMonday(y, 8));
  const xmas = ymd(y, 12, 25), wd = weekday(xmas);
  if (wd === 6) { set.add(ymd(y, 12, 27)); set.add(ymd(y, 12, 28)); }
  else if (wd === 0) { set.add(ymd(y, 12, 26)); set.add(ymd(y, 12, 27)); }
  else if (wd === 5) { set.add(xmas); set.add(ymd(y, 12, 28)); }
  else { set.add(xmas); set.add(ymd(y, 12, 26)); }
  holidayCache.set(y, set);
  return set;
}
export const isWorkingDay = s => { const w = weekday(s); return w !== 0 && w !== 6 && !bankHolidays(Number(s.slice(0, 4))).has(s); };
export function nextWorkingDay(s) { while (!isWorkingDay(s)) s = addDays(s, 1); return s; }
export function previousWorkingDay(s) { while (!isWorkingDay(s)) s = addDays(s, -1); return s; }

// Payday: last Thursday of the month, moved to the previous working day if that
// is a bank holiday (e.g. Boxing Day 2030). A per-month override always wins.
export function paydayFor(key, overrides = {}) {
  if (overrides[key]) return overrides[key];
  const [y, m] = key.split('-').map(Number);
  let s = ymd(y, m, lastDayOfMonth(y, m));
  while (weekday(s) !== 4) s = addDays(s, -1);
  return previousWorkingDay(s);
}

// Payday periods from the first payday month to the last, inclusive.
export function periods(firstKey, lastKey, overrides = {}) {
  const out = [];
  for (let k = firstKey; k <= lastKey; k = addMonths(k, 1)) {
    out.push({ key: k, start: paydayFor(k, overrides), end: addDays(paydayFor(addMonths(k, 1), overrides), -1) });
  }
  return out;
}
export function periodFor(date, list) {
  return list.find(p => p.start <= date && date <= p.end) || null;
}

export function shortDate(s) {
  if (!s) return '';
  return toDate(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}
export function longDate(s) {
  if (!s) return '';
  return toDate(s).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
export function periodName(p) {
  return toDate(p.start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
